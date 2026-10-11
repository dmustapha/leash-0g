import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';
import { isValidEciesPubkey } from '../crypto/ecies.js';

/**
 * Per-owner daily-loop settings (spec §5): Telegram link state, per-kind
 * channel prefs, digest schedule + cursor, and the owner-stream pubkey
 * (SET-ONCE — rotation is out of scope §12).
 */

export interface OwnerSettings {
  ownerAddr: string;
  telegramChatId: string | null;
  telegramLinkedAt: string | null;
  /** { [kind]: { telegram?: boolean } } — in-app is always on. */
  alertPrefs: Record<string, { telegram?: boolean | undefined }>;
  digestHourUtc: number | null;
  digestOptout: boolean;
  digestCursor: Json | null;
  streamPubkey: string | null;
  updatedAt: string;
}

interface DbRow {
  owner_addr: string;
  telegram_chat_id: string | null;
  telegram_linked_at: Date | null;
  alert_prefs: Record<string, { telegram?: boolean | undefined }>;
  digest_hour_utc: number | null;
  digest_optout: boolean;
  digest_cursor: Json | null;
  stream_pubkey: string | null;
  updated_at: Date;
}

function mapRow(r: DbRow): OwnerSettings {
  return {
    ownerAddr: r.owner_addr,
    telegramChatId: r.telegram_chat_id,
    telegramLinkedAt: r.telegram_linked_at ? r.telegram_linked_at.toISOString() : null,
    alertPrefs: r.alert_prefs ?? {},
    digestHourUtc: r.digest_hour_utc,
    digestOptout: r.digest_optout,
    digestCursor: r.digest_cursor,
    streamPubkey: r.stream_pubkey,
    updatedAt: r.updated_at.toISOString(),
  };
}

const DEFAULTS: OwnerSettings = {
  ownerAddr: '',
  telegramChatId: null,
  telegramLinkedAt: null,
  alertPrefs: {},
  digestHourUtc: null,
  digestOptout: false,
  digestCursor: null,
  streamPubkey: null,
  updatedAt: new Date(0).toISOString(),
};

/** Read (defaults when no row exists yet — settings rows are created lazily). */
export async function getOwnerSettings(pool: Pool, ownerAddr: string): Promise<OwnerSettings> {
  const res = await pool.query<DbRow>(`SELECT * FROM owner_settings WHERE owner_addr = $1`, [
    ownerAddr.toLowerCase(),
  ]);
  return res.rows[0] ? mapRow(res.rows[0]) : { ...DEFAULTS, ownerAddr: ownerAddr.toLowerCase() };
}

export interface OwnerSettingsPatch {
  alertPrefs?: Record<string, { telegram?: boolean | undefined }> | undefined;
  digestHourUtc?: number | null;
  digestOptout?: boolean;
}

// SCOPE-RH2-2: the owner-stream pubkey is NO LONGER set through patchOwnerSettings
// (that path couldn't populate the seq-anchored key history → divergence). All
// set/rotate goes through rotateOwnerStreamKey below. The old set-once
// StreamKeyAlreadySetError is gone (rotation is now supported).

export async function patchOwnerSettings(
  pool: Pool,
  ownerAddr: string,
  patch: OwnerSettingsPatch,
): Promise<OwnerSettings> {
  const owner = ownerAddr.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO owner_settings (owner_addr) VALUES ($1) ON CONFLICT (owner_addr) DO NOTHING`,
      [owner],
    );
    const res = await client.query<DbRow>(
      `UPDATE owner_settings SET
         alert_prefs = COALESCE($2::jsonb, alert_prefs),
         digest_hour_utc = CASE WHEN $3 THEN $4 ELSE digest_hour_utc END,
         digest_optout = COALESCE($5, digest_optout),
         updated_at = now()
       WHERE owner_addr = $1 RETURNING *`,
      [
        owner,
        patch.alertPrefs !== undefined ? JSON.stringify(patch.alertPrefs) : null,
        patch.digestHourUtc !== undefined,
        patch.digestHourUtc ?? null,
        patch.digestOptout ?? null,
      ],
    );
    await client.query('COMMIT');
    const row = res.rows[0];
    if (!row) throw new Error('owner_settings update failed');
    return mapRow(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Raised when a rotation is given a pubkey that is not a secp256k1 point. */
export class InvalidStreamKeyError extends Error {
  constructor() {
    super('stream pubkey is not a valid secp256k1 point');
    this.name = 'InvalidStreamKeyError';
  }
}

/**
 * SCOPE-RH2-2: rotate the owner-stream audit key. Inserts an owner_audit_keys
 * row effective at the NEXT owner_records seq — un-batched existing records
 * keep their current key, batches never span the boundary. The FIRST-ever set
 * lands at effective_from_seq = max+1 too (0 when no records exist), so the
 * original first-set flow still works. Also refreshes the current-key cache.
 */
export async function rotateOwnerStreamKey(
  pool: Pool,
  ownerAddr: string,
  pubkey: string,
): Promise<void> {
  const key = pubkey.replace(/^0x/, '');
  if (!isValidEciesPubkey(key)) throw new InvalidStreamKeyError();
  const owner = ownerAddr.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO owner_settings (owner_addr) VALUES ($1) ON CONFLICT (owner_addr) DO NOTHING`,
      [owner],
    );
    // FIRST-ever set → effective_from_seq 0 so the entire S10 pre-key backlog
    // (records that accumulated before any key existed) drains under it. A
    // ROTATION (a prior key already exists) → MAX(seq)+1 so already-batched /
    // un-batched records keep their current key and batches never span a boundary.
    await client.query(
      `INSERT INTO owner_audit_keys (owner_addr, pubkey, effective_from_seq)
       VALUES ($1, $2, CASE WHEN EXISTS (SELECT 1 FROM owner_audit_keys WHERE owner_addr = $1)
                            THEN (SELECT COALESCE(MAX(seq), -1) + 1 FROM owner_records WHERE owner_addr = $1)
                            ELSE 0 END)
       ON CONFLICT (owner_addr, effective_from_seq) DO UPDATE SET pubkey = EXCLUDED.pubkey`,
      [owner, key],
    );
    await client.query(`UPDATE owner_settings SET stream_pubkey = $2, updated_at = now() WHERE owner_addr = $1`, [
      owner,
      key,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Telegram link state transitions (used by the bot module). */
export async function setTelegramChat(pool: Pool, ownerAddr: string, chatId: string): Promise<void> {
  await pool.query(
    `INSERT INTO owner_settings (owner_addr, telegram_chat_id, telegram_linked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (owner_addr) DO UPDATE SET telegram_chat_id = $2, telegram_linked_at = now(), updated_at = now()`,
    [ownerAddr.toLowerCase(), chatId],
  );
}

export async function clearTelegramChat(pool: Pool, ownerAddr: string): Promise<void> {
  await pool.query(
    `UPDATE owner_settings SET telegram_chat_id = NULL, telegram_linked_at = NULL, updated_at = now()
     WHERE owner_addr = $1`,
    [ownerAddr.toLowerCase()],
  );
}

/** Find the owner bound to a chat (webhook side). */
export async function getOwnerByChatId(pool: Pool, chatId: string): Promise<string | null> {
  const res = await pool.query<{ owner_addr: string }>(
    `SELECT owner_addr FROM owner_settings WHERE telegram_chat_id = $1`,
    [chatId],
  );
  return res.rows[0]?.owner_addr ?? null;
}

/** Owners with a set digest hour, a linked chat, and no opt-out (scheduler input). */
export async function listDigestSchedulable(
  pool: Pool,
  defaultHourUtc: number,
): Promise<Array<{ ownerAddr: string; hourUtc: number; chatId: string }>> {
  const res = await pool.query<{ owner_addr: string; digest_hour_utc: number | null; telegram_chat_id: string }>(
    `SELECT owner_addr, digest_hour_utc, telegram_chat_id FROM owner_settings
     WHERE telegram_chat_id IS NOT NULL AND digest_optout = false`,
  );
  return res.rows.map((r) => ({
    ownerAddr: r.owner_addr,
    hourUtc: r.digest_hour_utc ?? defaultHourUtc,
    chatId: r.telegram_chat_id,
  }));
}
