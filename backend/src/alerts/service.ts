import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { Alert, AlertChannel, AlertClass, AlertKind, AlertResolution } from '../types.js';
import type { Json } from '../crypto/canonical.js';
import { appendOwnerRecordInTx } from '../store/owner-records.js';
import {
  upsertAlertInTx,
  countRecentEmissions,
  findOpenByApproval,
  findOpenByDedupKey,
  resolveAlertRow,
  dismissAlertRow,
  getAlert,
} from './store.js';

/**
 * THE single alert-emission chokepoint (spec §3b). Atomic core: the alert row
 * (dedup-upserted) and the owner-stream `alert` record commit in ONE
 * transaction — best-effort edges (SSE fan-out, Telegram push) fire strictly
 * post-commit and can never lose the durable alert or block the emitting
 * machinery. The per-owner rate guard trips into ONE coalescing `alert_storm`
 * row whose trip is itself owner-stream-recorded: nothing is silently dropped
 * (02 §6 honesty), the inbox and Telegram just stop amplifying.
 */

/**
 * P4C-2 advisory-lock key. `pg_advisory_xact_lock(classid, objid)` takes two
 * int4s; we fix a namespace class for alert emission and derive a signed-int32
 * object key from the owner address (FNV-1a → int32). This serializes all alert
 * emissions per owner without any owner-derived text touching SQL.
 */
const ALERT_LOCK_CLASS = 0x4c41; // "LA" — LEASH alerts namespace
function ownerLockKey(owner: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < owner.length; i++) {
    h ^= owner.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0; // to signed int32
}

export interface EmitAlertInput {
  agentId?: string;
  linkId?: string;
  class: AlertClass;
  kind: AlertKind;
  /** Plain-language, composed at the edge (00 §2c). */
  summary: string;
  refs?: Alert['refs'];
  dedupKey?: string;
}

/** Registered by the Telegram module (task-ordering: delivery is an EDGE, not the core). */
export interface TelegramDelivery {
  pushAlert(ownerAddr: string, alert: Alert): Promise<void>;
  /** Edit the sent card to its outcome + remove buttons (stale phones can't act). */
  resolveAlert(ownerAddr: string, alert: Alert): Promise<void>;
}

export interface AlertServiceDeps {
  pool: Pool;
  hub: SseHub;
  settings: { alertRatePerOwnerPerHour: number };
}

export class AlertService {
  private telegram: TelegramDelivery | null = null;

  constructor(private readonly deps: AlertServiceDeps) {}

  /** Late-bound Telegram edge (index.ts wires it after the bot exists). */
  setTelegramDelivery(delivery: TelegramDelivery): void {
    this.telegram = delivery;
  }

  /**
   * Emit an alert. Never throws into the calling machinery: a failure here is
   * logged and swallowed — alerting must not break approvals/revokes/loops.
   * Returns the durable alert (or null if emission failed / was storm-folded).
   */
  async emit(ownerAddr: string, input: EmitAlertInput): Promise<Alert | null> {
    try {
      return await this.emitOrThrow(ownerAddr, input);
    } catch (err) {
      console.error(`alert emit failed for owner ${ownerAddr} (${input.kind})`, err);
      return null;
    }
  }

  private async emitOrThrow(ownerAddr: string, input: EmitAlertInput): Promise<Alert | null> {
    const owner = ownerAddr.toLowerCase();
    const client = await this.deps.pool.connect();
    let alert: Alert;
    let stormFolded = false;
    try {
      // P4C-2: hoist the per-owner advisory lock to the TOP of the tx so the
      // count→(insert|fold) sequence is strictly serialized per owner. The
      // storm-fold branch may append NO owner record (deduped, non-50th), so
      // relying on the chained-append lock alone left a check-then-act race
      // that could admit a few extra alerts past the rate guard (no chain/
      // consent/fund impact, but a soft-cap breach). One lock, whole tx.
      //
      // The lock is folded INTO the BEGIN round-trip (one query, not two) using
      // the two-int4 advisory form with a JS-computed key — so it adds ZERO
      // extra round-trips per emit. Both operands are integers we compute here,
      // so nothing owner-derived is interpolated into SQL. The (classid,objid)
      // space is DISTINCT from the single-int8 `hashtextextended` locks the
      // chained-append helper uses, so the two never collide.
      await client.query(`BEGIN; SELECT pg_advisory_xact_lock(${ALERT_LOCK_CLASS}, ${ownerLockKey(owner)})`);
      // Rate guard (S11): counted INSIDE the tx — now under the owner lock, so
      // the count reflects every committed emission with no interleaving.
      const recent = await countRecentEmissions(client, owner);
      if (recent >= this.deps.settings.alertRatePerOwnerPerHour && input.kind !== 'alert_storm') {
        // Fold into ONE open storm row. The owner stream records the TRIP
        // (the storm row's creation) plus a periodic counter every 50th fold
        // — not one record per folded emission, or the storm would amplify
        // the append-only stream instead of the inbox. Nothing is lost: the
        // DURABLE storm row's count carries the folded total.
        const folded = await upsertAlertInTx(client, {
          ownerAddr: owner,
          class: 'info',
          kind: 'alert_storm',
          summary:
            'A burst of alerts tripped the rate guard — further alerts are being counted here instead of amplifying.',
          refs: { lastFoldedKind: input.kind },
          dedupKey: 'alert_storm',
        });
        if (!folded.deduped || folded.alert.count % 50 === 0) {
          await appendOwnerRecordInTx(client, owner, 'alert', {
            alertId: folded.alert.id,
            kind: 'alert_storm',
            foldedKind: input.kind,
            foldedSummary: input.summary,
            count: folded.alert.count,
          });
        }
        await client.query('COMMIT');
        alert = folded.alert;
        stormFolded = true;
      } else {
        const { alert: inserted } = await upsertAlertInTx(client, { ...input, ownerAddr: owner });
        // The 0G-logged owner stream carries VERIFIED facts only (00 §6b): strip
        // the model-authored `agentIntent` (untrusted; belongs only on the
        // ephemeral card, labeled unverified) so a hijacked agent cannot write
        // arbitrary text into the owner's permanent tamper-evident chain.
        const loggedRefs = { ...inserted.refs };
        delete loggedRefs.agentIntent;
        await appendOwnerRecordInTx(client, owner, 'alert', {
          alertId: inserted.id,
          class: inserted.class,
          kind: inserted.kind,
          summary: inserted.summary,
          refs: loggedRefs as Json,
          count: inserted.count,
          ...(inserted.agentId !== undefined ? { agentId: inserted.agentId } : {}),
          ...(inserted.linkId !== undefined ? { linkId: inserted.linkId } : {}),
        });
        await client.query('COMMIT');
        alert = inserted;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Post-commit best-effort edges — a throwing edge must never turn a
    // DURABLE emit into a failure (spec §3b: delivery failure loses nothing).
    try {
      this.deps.hub.emitOwner(owner, 'alert', { type: 'alert', alert });
    } catch (err) {
      console.error(`owner SSE fan-out failed for alert ${alert.id}`, err);
    }
    if (!stormFolded && this.telegram) {
      this.telegram.pushAlert(owner, alert).catch((err: unknown) => {
        console.error(`telegram push failed for alert ${alert.id}`, err);
      });
    }
    return alert;
  }

  /**
   * Auto-resolve the decision alert(s) tied to an approval — called from the
   * app decision path, the Telegram callback path, AND the timeout-expiry
   * paths (any channel resolves everywhere, spec D2). Appends the
   * `alert_resolved` owner record in the SAME transaction.
   */
  async resolveByApproval(
    approvalId: string,
    outcome: { resolution: Exclude<AlertResolution, 'dismissed'>; via: AlertChannel; agentId?: string; consentSeq?: number },
  ): Promise<Alert[]> {
    try {
      const resolved = await this.resolveWhere((client) => findOpenByApproval(client, approvalId), {
        resolution: outcome.resolution,
        via: outcome.via,
        extraRecord: {
          approvalId,
          ...(outcome.agentId !== undefined ? { agentId: outcome.agentId } : {}),
          ...(outcome.consentSeq !== undefined ? { consentSeq: outcome.consentSeq } : {}),
        },
      });
      return resolved;
    } catch (err) {
      console.error(`alert resolve failed for approval ${approvalId}`, err);
      return [];
    }
  }

  /** Resolve open alerts on a boundary dedup key (limit_hit boundary cleared). */
  async resolveByDedupKey(ownerAddr: string, dedupKey: string, via: AlertChannel = 'system'): Promise<Alert[]> {
    try {
      return await this.resolveWhere(
        (client) => findOpenByDedupKey(client, ownerAddr.toLowerCase(), dedupKey),
        { resolution: 'expired', via, extraRecord: { dedupKey, boundaryCleared: true } },
      );
    } catch (err) {
      console.error(`alert resolve failed for dedup key ${dedupKey}`, err);
      return [];
    }
  }

  private async resolveWhere(
    find: (client: import('pg').PoolClient) => Promise<Alert[]>,
    outcome: { resolution: AlertResolution; via: AlertChannel; extraRecord: Record<string, Json> },
  ): Promise<Alert[]> {
    const client = await this.deps.pool.connect();
    const resolved: Alert[] = [];
    try {
      await client.query('BEGIN');
      const open = await find(client);
      for (const a of open) {
        const r = await resolveAlertRow(client, a.id, outcome.resolution, outcome.via);
        if (!r) continue;
        await appendOwnerRecordInTx(client, r.ownerAddr, 'alert_resolved', {
          alertId: r.id,
          kind: r.kind,
          resolution: outcome.resolution,
          channel: outcome.via,
          ...outcome.extraRecord,
        });
        resolved.push(r);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    for (const r of resolved) {
      try {
        this.deps.hub.emitOwner(r.ownerAddr, 'alert', { type: 'alert', alert: r });
      } catch (err) {
        console.error(`owner SSE fan-out failed for alert ${r.id}`, err);
      }
      if (this.telegram) {
        this.telegram.resolveAlert(r.ownerAddr, r).catch((err: unknown) => {
          console.error(`telegram edit-on-resolve failed for alert ${r.id}`, err);
        });
      }
    }
    return resolved;
  }

  /**
   * Owner-initiated dismiss. approval_required NEVER dismisses (it resolves
   * only via its approval — deny-by-default stands); limit_hit and info
   * alerts dismiss freely (spec §3b lifecycle).
   */
  async dismiss(alertId: string): Promise<Alert | null | 'not_dismissible'> {
    const existing = await getAlert(this.deps.pool, alertId);
    if (!existing) return null;
    if (existing.kind === 'approval_required') return 'not_dismissible';
    const client = await this.deps.pool.connect();
    let dismissed: Alert | null = null;
    try {
      await client.query('BEGIN');
      dismissed = await dismissAlertRow(client, alertId);
      if (dismissed) {
        await appendOwnerRecordInTx(client, dismissed.ownerAddr, 'alert_resolved', {
          alertId: dismissed.id,
          kind: dismissed.kind,
          resolution: 'dismissed',
          channel: 'app',
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (dismissed) {
      try {
        this.deps.hub.emitOwner(dismissed.ownerAddr, 'alert', { type: 'alert', alert: dismissed });
      } catch (err) {
        console.error(`owner SSE fan-out failed for alert ${dismissed.id}`, err);
      }
      if (this.telegram) {
        this.telegram.resolveAlert(dismissed.ownerAddr, dismissed).catch(() => undefined);
      }
    }
    return dismissed;
  }
}
