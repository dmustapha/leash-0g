import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import { appendOwnerRecordInTx } from '../store/owner-records.js';
import { getOwnerSettings, listDigestSchedulable } from '../store/owner-settings.js';

/**
 * The digest (spec §3b "Digest service", D4): spend + balance change +
 * activity since the owner's last mark. Source of truth = the hash-chained
 * traces (per-agent seq high-water marks — never timestamps) + delegation
 * rows (per-link figures). Money label = "balance change" (Gate-① build note
 * 1): the snapshot delta measures NET movement — outflows move it too — so
 * "inflows" would overclaim; "earned" stays out until payments (07 🟢 #11).
 *
 * Cursor (owner_settings.digest_cursor): { ts, lastPushDate?, agents: {
 * [agentId]: { seq, balanceWei } } }. Advancing the cursor and appending the
 * owner-stream `digest` record commit in ONE transaction, serialized per
 * owner via the owner advisory lock the record append already takes — a mark
 * racing the scheduled push cannot double-count.
 */

export interface DigestCursor {
  ts: string;
  /** YYYY-MM-DD of the last SCHEDULED push (catch-up bookkeeping). */
  lastPushDate?: string;
  agents: Record<string, { seq: number; balanceWei: string }>;
}

export interface AgentDigest {
  agentId: string;
  name: string;
  status: string;
  spendWei: string;
  balanceWei: string;
  /** null until a snapshot exists (first digest has no baseline — honest). */
  balanceChangeWei: string | null;
  actions: number;
  blocks: number;
  modifies: number;
  approvals: { approved: number; denied: number; expired: number };
  delegationsTerminal: Record<string, number>;
}

export interface LinkDigest {
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  byStatus: Record<string, number>;
}

export interface Digest {
  generatedAt: string;
  since: string | null;
  agents: AgentDigest[];
  links: LinkDigest[];
  totals: { spendWei: string; actions: number; decisions: number };
  empty: boolean;
}

export interface DigestServiceDeps {
  pool: Pool;
  chain: { getBalance(addr: string): Promise<bigint> };
  settings: { digestDefaultHourUtc: number };
}

interface AgentRowLite {
  id: string;
  name: string;
  status: string;
  account_addr: string;
}

export class DigestService {
  constructor(private readonly deps: DigestServiceDeps) {}

  private async loadCursor(ownerAddr: string): Promise<DigestCursor | null> {
    const s = await getOwnerSettings(this.deps.pool, ownerAddr);
    const c = s.digestCursor;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return null;
    return c as unknown as DigestCursor;
  }

  /**
   * Compute the digest since the cursor WITHOUT advancing it (preview /
   * GET /api/digest). Balance reads are live (small N, owner-paced).
   */
  async compute(ownerAddr: string): Promise<{ digest: Digest; nextCursor: DigestCursor }> {
    const owner = ownerAddr.toLowerCase();
    const cursor = await this.loadCursor(owner);
    const agents = await this.deps.pool.query<AgentRowLite>(
      `SELECT id, name, status, account_addr FROM agents WHERE owner_addr = $1 ORDER BY created_at ASC`,
      [owner],
    );
    const perAgent: AgentDigest[] = [];
    const nextAgents: DigestCursor['agents'] = {};
    let totalSpend = 0n;
    let totalActions = 0;
    let totalDecisions = 0;

    for (const a of agents.rows) {
      const prior = cursor?.agents[a.id];
      const afterSeq = prior?.seq ?? -1;
      const rows = await this.deps.pool.query<{ record: Json; kind: string; seq: string }>(
        `SELECT record, kind, seq FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC`,
        [a.id, afterSeq],
      );
      let spend = 0n;
      let actions = 0;
      let blocks = 0;
      let modifies = 0;
      const approvals = { approved: 0, denied: 0, expired: 0 };
      const delegationsTerminal: Record<string, number> = {};
      let headSeq = afterSeq;
      for (const r of rows.rows) {
        headSeq = Math.max(headSeq, Number(r.seq));
        const rec = r.record as Record<string, Json | undefined>;
        const detail = (rec['detail'] ?? {}) as Record<string, Json | undefined>;
        switch (r.kind) {
          case 'action': {
            actions += 1;
            const v = detail['valueWei'];
            if (typeof v === 'string' && /^\d+$/.test(v)) spend += BigInt(v);
            break;
          }
          case 'block':
            blocks += 1;
            break;
          case 'modify':
            modifies += 1;
            break;
          case 'consent': {
            const d = rec['decision'];
            if (d === 'approve') approvals.approved += 1;
            else if (d === 'deny') approvals.denied += 1;
            else if (d === 'expired') approvals.expired += 1;
            break;
          }
          case 'delegation_update': {
            const status = detail['status'];
            if (
              typeof status === 'string' &&
              ['completed', 'failed', 'declined', 'cancelled', 'expired'].includes(status)
            ) {
              delegationsTerminal[status] = (delegationsTerminal[status] ?? 0) + 1;
            }
            break;
          }
          default:
            break;
        }
      }
      const balance = await this.deps.chain.getBalance(a.account_addr);
      const priorBalance = prior?.balanceWei;
      perAgent.push({
        agentId: a.id,
        name: a.name,
        status: a.status,
        spendWei: spend.toString(),
        balanceWei: balance.toString(),
        balanceChangeWei: priorBalance !== undefined ? (balance - BigInt(priorBalance)).toString() : null,
        actions,
        blocks,
        modifies,
        approvals,
        delegationsTerminal,
      });
      nextAgents[a.id] = { seq: headSeq, balanceWei: balance.toString() };
      totalSpend += spend;
      totalActions += actions;
      totalDecisions += approvals.approved + approvals.denied + approvals.expired;
    }

    // Per-link figures from delegation rows decided since the mark (spec §3b:
    // these are row-sourced, not trace-sourced — timestamps are correct here).
    const sinceTs = cursor?.ts ?? new Date(0).toISOString();
    const linkRows = await this.deps.pool.query<{
      link_id: string;
      from_agent_id: string;
      to_agent_id: string;
      status: string;
      n: string;
    }>(
      `SELECT d.link_id, l.from_agent_id, l.to_agent_id, d.status, count(*) AS n
       FROM delegations d JOIN links l ON l.id = d.link_id
       WHERE l.owner_addr = $1 AND d.decided_at IS NOT NULL AND d.decided_at > $2
       GROUP BY d.link_id, l.from_agent_id, l.to_agent_id, d.status`,
      [owner, sinceTs],
    );
    const linkMap = new Map<string, LinkDigest>();
    for (const r of linkRows.rows) {
      let entry = linkMap.get(r.link_id);
      if (!entry) {
        entry = { linkId: r.link_id, fromAgentId: r.from_agent_id, toAgentId: r.to_agent_id, byStatus: {} };
        linkMap.set(r.link_id, entry);
      }
      entry.byStatus[r.status] = Number(r.n);
    }

    const generatedAt = new Date().toISOString();
    const links = [...linkMap.values()];
    const hasActivity =
      totalActions > 0 ||
      totalDecisions > 0 ||
      links.length > 0 ||
      perAgent.some(
        (a) => a.blocks > 0 || a.modifies > 0 || Object.keys(a.delegationsTerminal).length > 0 || a.spendWei !== '0',
      );
    return {
      digest: {
        generatedAt,
        since: cursor?.ts ?? null,
        agents: perAgent,
        links,
        totals: { spendWei: totalSpend.toString(), actions: totalActions, decisions: totalDecisions },
        empty: !hasActivity,
      },
      nextCursor: {
        ts: generatedAt,
        ...(cursor?.lastPushDate !== undefined ? { lastPushDate: cursor.lastPushDate } : {}),
        agents: nextAgents,
      },
    };
  }

  /**
   * Generate a digest AND advance the cursor + append the owner-stream
   * `digest` record — one transaction (the owner advisory lock inside the
   * record append serializes a mark racing the scheduled push).
   */
  async mark(ownerAddr: string, opts: { scheduled?: boolean } = {}): Promise<Digest> {
    const owner = ownerAddr.toLowerCase();
    // A SESSION advisory lock held across compute → advance: two concurrent
    // marks (owner tap racing the scheduled push) fully serialize, so the
    // second computes from the ALREADY-ADVANCED cursor — no double-count.
    // (A tx-scoped lock inside the write tx would still let both compute the
    // same stale range first.)
    const lockClient = await this.deps.pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 42))', [`digest:${owner}`]);
      const { digest, nextCursor } = await this.compute(owner);
      if (opts.scheduled) {
        nextCursor.lastPushDate = new Date().toISOString().slice(0, 10);
      }
      const client = await this.deps.pool.connect();
      try {
        await client.query('BEGIN');
        await appendOwnerRecordInTx(client, owner, 'digest', {
          digest: digest as unknown as Json,
          cursorFrom: digest.since,
          cursorTo: digest.generatedAt,
          ...(opts.scheduled ? { scheduled: true } : {}),
        });
        await client.query(
          `INSERT INTO owner_settings (owner_addr, digest_cursor) VALUES ($1, $2)
           ON CONFLICT (owner_addr) DO UPDATE SET digest_cursor = $2, updated_at = now()`,
          [owner, JSON.stringify(nextCursor)],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return digest;
    } finally {
      await lockClient
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 42))', [`digest:${owner}`])
        .catch(() => undefined);
      lockClient.release();
    }
  }

  /** Plain-language Telegram rendering (00 §2c; minimal disclosure — amounts + counts only). */
  renderText(digest: Digest): string {
    if (digest.empty) return 'Nothing new since you last looked.';
    const lines: string[] = ['Your agents since you last looked:'];
    for (const a of digest.agents) {
      const parts: string[] = [];
      if (a.actions > 0) parts.push(`${a.actions} action(s), spent ${formatWei(a.spendWei)}`);
      if (a.balanceChangeWei !== null && a.balanceChangeWei !== '0') {
        parts.push(`balance change ${formatWei(a.balanceChangeWei, true)}`);
      }
      const decided = a.approvals.approved + a.approvals.denied + a.approvals.expired;
      if (decided > 0) parts.push(`${decided} decision(s)`);
      if (a.blocks > 0) parts.push(`${a.blocks} blocked`);
      const terminal = Object.entries(a.delegationsTerminal)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      if (terminal) parts.push(`handoffs: ${terminal}`);
      if (parts.length > 0) lines.push(`• ${a.name}: ${parts.join(' · ')}`);
    }
    lines.push(`Total spend: ${formatWei(digest.totals.spendWei)}.`);
    return lines.join('\n');
  }

  /**
   * Scheduler tick (spec §3b): fires the daily push when the owner's hour has
   * passed and none was sent today (catch-up window — a deploy over the exact
   * hour costs at worst one LATE digest, never a missed day). Empty digests
   * are skipped without advancing anything (no noise, no fake mark).
   */
  async scheduledTick(
    now: Date,
    push: (ownerAddr: string, chatId: string, text: string) => Promise<void>,
  ): Promise<number> {
    const schedulable = await listDigestSchedulable(this.deps.pool, this.deps.settings.digestDefaultHourUtc);
    const today = now.toISOString().slice(0, 10);
    let pushed = 0;
    for (const s of schedulable) {
      if (now.getUTCHours() < s.hourUtc) continue; // not due yet today
      const cursor = await this.loadCursor(s.ownerAddr);
      if (cursor?.lastPushDate === today) continue; // already sent today
      try {
        const { digest } = await this.compute(s.ownerAddr);
        if (digest.empty) {
          // Skipped, but the day is marked done — an empty fleet must not be
          // re-checked every tick until midnight.
          await this.markPushDateOnly(s.ownerAddr, today);
          continue;
        }
        const marked = await this.mark(s.ownerAddr, { scheduled: true });
        await push(s.ownerAddr, s.chatId, this.renderText(marked));
        pushed += 1;
      } catch (err) {
        console.error(`scheduled digest failed for ${s.ownerAddr}`, err);
      }
    }
    return pushed;
  }

  private async markPushDateOnly(ownerAddr: string, date: string): Promise<void> {
    const cursor = (await this.loadCursor(ownerAddr)) ?? { ts: new Date(0).toISOString(), agents: {} };
    cursor.lastPushDate = date;
    await this.deps.pool.query(
      `INSERT INTO owner_settings (owner_addr, digest_cursor) VALUES ($1, $2)
       ON CONFLICT (owner_addr) DO UPDATE SET digest_cursor = $2, updated_at = now()`,
      [ownerAddr.toLowerCase(), JSON.stringify(cursor)],
    );
  }
}

function formatWei(wei: string, signed = false): string {
  const neg = wei.startsWith('-');
  const abs = neg ? wei.slice(1) : wei;
  const padded = abs.padStart(19, '0');
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(-18).replace(/0+$/, '').slice(0, 6);
  const num = frac ? `${whole}.${frac}` : whole;
  return `${neg ? '-' : signed ? '+' : ''}${num} 0G`;
}
