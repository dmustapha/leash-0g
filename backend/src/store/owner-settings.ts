import type { Pool } from 'pg';
import type { Json } from '../crypto/canonical.js';

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
  streamPubkey?: string;
}

/** Raised when a PATCH tries to overwrite the set-once stream pubkey. */
export class StreamKeyAlreadySetError extends Error {
  constructor() {
    super('owner-stream pubkey is set-once (rotation is a deferred slice)');
  }
}

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
    if (patch.streamPubkey !== undefined) {
      const existing = await client.query<{ stream_pubkey: string | null }>(
        `SELECT stream_pubkey FROM owner_settings WHERE owner_addr = $1 FOR UPDATE`,
        [owner],
      );
      const current = existing.rows[0]?.stream_pubkey ?? null;
      if (current !== null && current !== patch.streamPubkey) {
        await client.query('ROLLBACK');
        throw new StreamKeyAlreadySetError();
      }
    }
    const res = await client.query<DbRow>(
      `UPDATE owner_settings SET
         alert_prefs = COALESCE($2::jsonb, alert_prefs),
         digest_hour_utc = CASE WHEN $3 THEN $4 ELSE digest_hour_utc END,
         digest_optout = COALESCE($5, digest_optout),
         stream_pubkey = COALESCE($6, stream_pubkey),
         updated_at = now()
       WHERE owner_addr = $1 RETURNING *`,
      [
        owner,
        patch.alertPrefs !== undefined ? JSON.stringify(patch.alertPrefs) : null,
        patch.digestHourUtc !== undefined,
        patch.digestHourUtc ?? null,
        patch.digestOptout ?? null,
        patch.streamPubkey ?? null,
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
