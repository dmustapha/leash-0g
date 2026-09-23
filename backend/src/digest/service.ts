import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import { appendOwnerRecordInTx } from '../store/owner-records.js';
import { getOwnerSettings, listDigestSchedulable } from '../store/owner-settings.js';
import { formatG } from '../util/format.js';

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
  /**
   * §8 calibration: job-fee settlements are governed ERC-20 transfers, kept
   * SEPARATE from native `spendWei` (18dp 0G) — a 6dp token fee must never be
   * summed into the native total. count + summed amount per token address.
   */
  jobFees: { count: number; byToken: Record<string, string> };
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
  totals: { spendWei: string; actions: number; decisions: number; jobFees: { count: number; byToken: Record<string, string> } };
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
    const totalJobFeeByToken = new Map<string, bigint>();
    let totalJobFeeCount = 0;

    for (const a of agents.rows) {
      const prior = cursor?.agents[a.id];
      const afterSeq = prior?.seq ?? -1;
      const rows = await this.deps.pool.query<{ record: Json; kind: string; seq: string }>(
        `SELECT record, kind, seq FROM trace_records WHERE agent_id = $1 AND seq > $2 ORDER BY seq ASC`,
        [a.id, afterSeq],
      );
      let spend = 0n;
      const jobFeeByToken = new Map<string, bigint>();
      let jobFeeCount = 0;
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
            // §8: a job-fee settlement is a governed ERC-20 transfer carrying
            // category:'jobFee' + feeAmountWei (6dp token, per feeToken). It is
            // NOT a native treasury transfer — keep it out of the native action
            // count AND the native spendWei total; report it on its own line.
            if (detail['category'] === 'jobFee') {
              const token = detail['feeToken'];
              const amt = detail['feeAmountWei'];
              if (typeof token === 'string' && typeof amt === 'string' && /^\d+$/.test(amt)) {
                // Normalize the address so a checksummed feeToken never splits
                // into a second Map key and desyncs the per-token total.
                const key = token.toLowerCase();
                jobFeeByToken.set(key, (jobFeeByToken.get(key) ?? 0n) + BigInt(amt));
                jobFeeCount += 1;
              }
              break;
            }
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
        jobFees: { count: jobFeeCount, byToken: Object.fromEntries([...jobFeeByToken].map(([t, v]) => [t, v.toString()])) },
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
      totalJobFeeCount += jobFeeCount;
      for (const [t, v] of jobFeeByToken) totalJobFeeByToken.set(t, (totalJobFeeByToken.get(t) ?? 0n) + v);
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
        (a) =>
          a.blocks > 0 ||
          a.modifies > 0 ||
          Object.keys(a.delegationsTerminal).length > 0 ||
          a.spendWei !== '0' ||
          a.jobFees.count > 0,
      );
    return {
      digest: {
        generatedAt,
        since: cursor?.ts ?? null,
        agents: perAgent,
        links,
        totals: {
          spendWei: totalSpend.toString(),
          actions: totalActions,
          decisions: totalDecisions,
          jobFees: {
            count: totalJobFeeCount,
            byToken: Object.fromEntries([...totalJobFeeByToken].map(([t, v]) => [t, v.toString()])),
          },
        },
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

  /**
   * Plain-language Telegram rendering (00 §2c; minimal disclosure — names,
   * amounts, counts only). Reads like a standup briefing, not a changelog:
   * one lead sentence, per-agent lines only where something happened, and an
   * attention line only when something deserves a look.
   */
  renderText(digest: Digest): string {
    if (digest.empty) return 'Nothing new since you last looked — your agents are quiet.';

    const decisions = digest.totals.decisions;
    const jobFeeCount = digest.totals.jobFees.count;
    // §8: compose the lead from independent clauses so no movement is dropped.
    // Job-fee settlements are named distinctly from native transfers (a token
    // fee must never read as a 0G outflow), and the "decisions came to you"
    // clause is emitted regardless of whether native transfers happened — the
    // flagship job path is actions=0, decisions≥1, jobFees≥1.
    const clauses: string[] = [];
    if (digest.totals.actions > 0) {
      clauses.push(`${plural(digest.totals.actions, 'transfer')} went out, ${formatG(digest.totals.spendWei)} total`);
    }
    if (jobFeeCount > 0) clauses.push(`${plural(jobFeeCount, 'job fee')} settled`);
    if (decisions > 0) clauses.push(`${plural(decisions, 'decision')} came to you`);
    const lead = clauses.length
      ? `Since you last looked: ${clauses.join(', ')}.`
      : 'Since you last looked: no money moved, but there was some activity.';

    const nameOf = new Map(digest.agents.map((a) => [a.agentId, a.name]));
    const lines: string[] = [lead, ''];
    for (const a of digest.agents) {
      const bits: string[] = [];
      if (a.actions > 0) bits.push(`sent ${formatG(a.spendWei)} in ${plural(a.actions, 'transfer')}`);
      if (a.jobFees.count > 0) bits.push(`settled ${plural(a.jobFees.count, 'job fee')}`);
      if (a.balanceChangeWei !== null && a.balanceChangeWei !== '0') {
        bits.push(`balance ${formatG(a.balanceWei)} (${formatG(a.balanceChangeWei, true)})`);
      }
      const decided = a.approvals.approved + a.approvals.denied + a.approvals.expired;
      if (decided > 0) {
        const parts: string[] = [];
        if (a.approvals.approved > 0) parts.push(`${a.approvals.approved} approved`);
        if (a.approvals.denied > 0) parts.push(`${a.approvals.denied} denied`);
        if (a.approvals.expired > 0) parts.push(`${a.approvals.expired} expired unanswered`);
        bits.push(parts.join(', '));
      }
      if (a.modifies > 0) bits.push(`${plural(a.modifies, 'limit change')} you made`);
      const done = a.delegationsTerminal['completed'] ?? 0;
      const rough = ['failed', 'declined', 'cancelled', 'expired']
        .map((k) => a.delegationsTerminal[k] ?? 0)
        .reduce((x, y) => x + y, 0);
      if (done > 0) bits.push(`${plural(done, 'handoff')} completed`);
      if (rough > 0) bits.push(`${plural(rough, 'handoff')} didn't go through`);
      if (bits.length > 0) lines.push(`🐕 ${a.name} — ${bits.join(' · ')}`);
    }

    // Cross-agent handoffs, named and directional (row-sourced links) — a
    // fleet's coordination is invisible without WHO handed off to WHOM.
    if (digest.links.length > 0) {
      lines.push('', 'Handoffs between your agents:');
      for (const l of digest.links) {
        const from = nameOf.get(l.fromAgentId) ?? 'an agent';
        const to = nameOf.get(l.toAgentId) ?? 'an agent';
        const parts = Object.entries(l.byStatus)
          .map(([status, n]) => `${n} ${status === 'completed' ? 'completed' : status}`)
          .join(', ');
        lines.push(`↪ ${from} → ${to}: ${parts}`);
      }
    }

    const attention: string[] = [];
    for (const a of digest.agents) {
      if (a.blocks > 0) attention.push(`${a.name} had ${plural(a.blocks, 'request')} blocked by your rules`);
      if (a.approvals.expired > 0) attention.push(`${a.name} had approvals expire unanswered`);
    }
    if (attention.length > 0) {
      lines.push('', `Worth a look: ${attention.join('; ')}.`);
    }
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
    // L-01 (security gate): an atomic jsonb MERGE — a read-modify-write here
    // could clobber a cursor advanced by a concurrent mark (no lock needed
    // when only the one key is merged).
    await this.deps.pool.query(
      `INSERT INTO owner_settings (owner_addr, digest_cursor)
       VALUES ($1, jsonb_build_object('ts', to_jsonb(to_char(to_timestamp(0), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), 'agents', '{}'::jsonb, 'lastPushDate', to_jsonb($2::text)))
       ON CONFLICT (owner_addr) DO UPDATE
         SET digest_cursor = COALESCE(owner_settings.digest_cursor, '{"ts":"1970-01-01T00:00:00.000Z","agents":{}}'::jsonb)
                             || jsonb_build_object('lastPushDate', to_jsonb($2::text)),
             updated_at = now()`,
      [ownerAddr.toLowerCase(), date],
    );
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
