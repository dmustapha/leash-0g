import type { Pool, PoolClient } from 'pg';
import type { Alert, AlertChannel, AlertClass, AlertKind, AlertResolution, AlertStatus } from '../types.js';
import type { Json } from '../crypto/canonical.js';

interface DbAlertRow {
  id: string;
  owner_addr: string;
  agent_id: string | null;
  link_id: string | null;
  class: AlertClass;
  kind: AlertKind;
  status: AlertStatus;
  summary: string;
  refs: Alert['refs'];
  count: number;
  dedup_key: string | null;
  telegram_message_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
  resolution: AlertResolution | null;
  resolved_via: AlertChannel | null;
}

export function mapAlert(r: DbAlertRow): Alert {
  return {
    id: r.id,
    ownerAddr: r.owner_addr,
    ...(r.agent_id !== null ? { agentId: r.agent_id } : {}),
    ...(r.link_id !== null ? { linkId: r.link_id } : {}),
    class: r.class,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    refs: r.refs ?? {},
    count: r.count,
    ...(r.dedup_key !== null ? { dedupKey: r.dedup_key } : {}),
    ...(r.telegram_message_id !== null ? { telegramMessageId: r.telegram_message_id } : {}),
    createdAt: r.created_at.toISOString(),
    ...(r.resolved_at !== null ? { resolvedAt: r.resolved_at.toISOString() } : {}),
    ...(r.resolution !== null ? { resolution: r.resolution } : {}),
    ...(r.resolved_via !== null ? { resolvedVia: r.resolved_via } : {}),
  };
}

export interface InsertAlertInput {
  ownerAddr: string;
  agentId?: string;
  linkId?: string;
  class: AlertClass;
  kind: AlertKind;
  summary: string;
  refs?: Alert['refs'];
  dedupKey?: string;
}

/**
 * Dedup-upsert (spec §3b): the partial unique index (owner, dedup_key) over
 * OPEN rows makes concurrent same-key emits land as ONE row with count
 * incremented — no check-then-insert race. Rows without a dedupKey always
 * insert fresh. Runs on the caller's client (inside the emit transaction).
 */
export async function upsertAlertInTx(client: PoolClient, input: InsertAlertInput): Promise<{ alert: Alert; deduped: boolean }> {
  if (input.dedupKey === undefined) {
    const res = await client.query<DbAlertRow>(
      `INSERT INTO alerts (owner_addr, agent_id, link_id, class, kind, summary, refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.ownerAddr.toLowerCase(),
        input.agentId ?? null,
        input.linkId ?? null,
        input.class,
        input.kind,
        input.summary,
        JSON.stringify(input.refs ?? {}),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('alert insert failed');
    return { alert: mapAlert(row), deduped: false };
  }
  const res = await client.query<DbAlertRow & { inserted: boolean }>(
    `INSERT INTO alerts (owner_addr, agent_id, link_id, class, kind, summary, refs, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (owner_addr, dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('unread','read')
     DO UPDATE SET count = alerts.count + 1, updated_at = now(),
                   summary = EXCLUDED.summary, refs = EXCLUDED.refs
     RETURNING *, (xmax = 0) AS inserted`,
    [
      input.ownerAddr.toLowerCase(),
      input.agentId ?? null,
      input.linkId ?? null,
      input.class,
      input.kind,
      input.summary,
      JSON.stringify(input.refs ?? {}),
      input.dedupKey,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('alert upsert failed');
  return { alert: mapAlert(row), deduped: !row.inserted };
}

/** Per-owner alert INSERTS in the trailing hour — the rate-guard input (dedup increments reuse a row and don't amplify). */
export async function countRecentEmissions(client: PoolClient, ownerAddr: string): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM alerts WHERE owner_addr = $1 AND created_at > now() - interval '1 hour'`,
    [ownerAddr.toLowerCase()],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function getAlert(pool: Pool, id: string): Promise<Alert | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const res = await pool.query<DbAlertRow>(`SELECT * FROM alerts WHERE id = $1`, [id]);
  return res.rows[0] ? mapAlert(res.rows[0]) : null;
}

export interface ListAlertsOptions {
  class?: AlertClass;
  kind?: AlertKind;
  agentId?: string;
  status?: AlertStatus;
  cursor?: string; // `<createdAtISO>_<id>` keyset, newest-first
  limit?: number;
}

export async function listAlerts(
  pool: Pool,
  ownerAddr: string,
  opts: ListAlertsOptions = {},
): Promise<{ alerts: Alert[]; nextCursor?: string }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: string[] = ['owner_addr = $1'];
  const params: unknown[] = [ownerAddr.toLowerCase()];
  if (opts.class !== undefined) {
    params.push(opts.class);
    where.push(`class = $${params.length}`);
  }
  if (opts.kind !== undefined) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.agentId !== undefined) {
    params.push(opts.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  if (opts.status !== undefined) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.cursor !== undefined) {
    const sep = opts.cursor.lastIndexOf('_');
    const createdAt = opts.cursor.slice(0, sep);
    const id = opts.cursor.slice(sep + 1);
    if (sep > 0 && !Number.isNaN(Date.parse(createdAt)) && /^[0-9a-f-]{36}$/i.test(id)) {
      params.push(createdAt, id);
      where.push(
        `(date_trunc('milliseconds', created_at), id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
  }
  params.push(limit + 1);
  const res = await pool.query<DbAlertRow>(
    `SELECT * FROM alerts WHERE ${where.join(' AND ')}
     ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const page = res.rows.slice(0, limit).map(mapAlert);
  const last = page[page.length - 1];
  return {
    alerts: page,
    ...(res.rows.length > limit && last ? { nextCursor: `${last.createdAt}_${last.id}` } : {}),
  };
}

/** Count of open (unread) alerts — the SiteNav badge. */
export async function countUnread(pool: Pool, ownerAddr: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM alerts WHERE owner_addr = $1 AND status = 'unread'`,
    [ownerAddr.toLowerCase()],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** unread → read (info AND decision alerts — reading is always allowed). */
export async function markAlertRead(pool: Pool, id: string): Promise<Alert | null> {
  const res = await pool.query<DbAlertRow>(
    `UPDATE alerts SET status = 'read', updated_at = now() WHERE id = $1 AND status = 'unread' RETURNING *`,
    [id],
  );
  return res.rows[0] ? mapAlert(res.rows[0]) : null;
}

/** Open → dismissed. Callers gate WHICH kinds may be dismissed (service layer). */
export async function dismissAlertRow(client: PoolClient, id: string): Promise<Alert | null> {
  const res = await client.query<DbAlertRow>(
    `UPDATE alerts SET status = 'dismissed', resolution = 'dismissed', resolved_via = 'app',
            resolved_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('unread','read') RETURNING *`,
    [id],
  );
  return res.rows[0] ? mapAlert(res.rows[0]) : null;
}

/** Bulk: open INFO alerts → read (decision alerts untouched, spec §4). */
export async function markAllInfoRead(pool: Pool, ownerAddr: string): Promise<number> {
  const res = await pool.query(
    `UPDATE alerts SET status = 'read', updated_at = now()
     WHERE owner_addr = $1 AND status = 'unread' AND class = 'info'`,
    [ownerAddr.toLowerCase()],
  );
  return res.rowCount ?? 0;
}

/** Open alerts referencing an approval (auto-resolve path). */
export async function findOpenByApproval(client: PoolClient, approvalId: string): Promise<Alert[]> {
  const res = await client.query<DbAlertRow>(
    `SELECT * FROM alerts WHERE refs->>'approvalId' = $1 AND status IN ('unread','read') FOR UPDATE`,
    [approvalId],
  );
  return res.rows.map(mapAlert);
}

/** Open limit_hit alerts for a boundary dedup key (boundary-cleared resolve). */
export async function findOpenByDedupKey(client: PoolClient, ownerAddr: string, dedupKey: string): Promise<Alert[]> {
  const res = await client.query<DbAlertRow>(
    `SELECT * FROM alerts WHERE owner_addr = $1 AND dedup_key = $2 AND status IN ('unread','read') FOR UPDATE`,
    [ownerAddr.toLowerCase(), dedupKey],
  );
  return res.rows.map(mapAlert);
}

export async function resolveAlertRow(
  client: PoolClient,
  id: string,
  resolution: AlertResolution,
  via: AlertChannel,
): Promise<Alert | null> {
  const res = await client.query<DbAlertRow>(
    `UPDATE alerts SET status = 'resolved', resolution = $2, resolved_via = $3,
            resolved_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('unread','read') RETURNING *`,
    [id, resolution, via],
  );
  return res.rows[0] ? mapAlert(res.rows[0]) : null;
}

/** Store the Telegram message id for later edit-on-resolve. */
export async function setTelegramMessageId(pool: Pool, id: string, messageId: string): Promise<void> {
  await pool.query(`UPDATE alerts SET telegram_message_id = $2, updated_at = now() WHERE id = $1`, [id, messageId]);
}

export type { Json };
