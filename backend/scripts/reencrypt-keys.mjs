// SCOPE-I-7: operator-run KEK re-encryption — migrate every stored agent secret
// (session_key_enc + gateway_token_enc) onto the current PRIMARY key. Run this
// AFTER adding a new primary key to the keyring, so existing blobs stop depending
// on the retired key and the old KEK can eventually be dropped.
//
//   # 1. add the new key + point the primary at it (same env the backend boots with):
//   export KEY_ENCRYPTION_SECRET=<legacy 64-hex, id '0'>
//   export KEY_ENCRYPTION_KEYRING='{"1":"<new 64-hex>"}'
//   export KEY_ENCRYPTION_PRIMARY_ID=1
//   # 2. re-encrypt (uses MIGRATE_DATABASE_URL if set, else DATABASE_URL):
//   cd backend && npx tsx scripts/reencrypt-keys.mjs
//
// It is IDEMPOTENT: each blob is decrypted under whichever key sealed it (legacy
// pure-hex or any v1:<id>:) and re-encrypted under the primary. Re-running is safe
// (a blob already on the primary round-trips to an equivalent blob). This is NOT a
// boot migration — the backend never rewrites existing blobs on its own.
//
// ROLLBACK: keep the retired key in KEY_ENCRYPTION_KEYRING until this has run on
// every environment; decrypt stays backward-compatible as long as the old key is
// present. Only remove it once all rows are confirmed migrated.
import pg from 'pg';
import { loadConfig, resolveKeyring } from '../src/config.js';
import { encryptSecret, decryptSecret } from '../src/crypto/keycrypt.js';

const cfg = loadConfig();
const keyring = resolveKeyring(cfg);
const connectionString = cfg.MIGRATE_DATABASE_URL ?? cfg.DATABASE_URL;
const pool = new pg.Pool({ connectionString, max: 1 });

/** Re-encrypt one column value onto the primary; null passes through untouched. */
function reencrypt(blob) {
  if (blob == null) return null;
  return encryptSecret(decryptSecret(blob, keyring), keyring);
}

/**
 * Which key sealed this blob: '0' for a legacy pure-hex blob, else the v1 id.
 * A deterministic skip on blob SHAPE — a ciphertext-equality skip can never fire
 * because encryptSecret randomises the IV, so every re-run would rewrite the
 * whole table.
 */
function sealingKeyId(blob) {
  if (blob == null) return null;
  if (blob.startsWith('v1:')) {
    const sep = blob.indexOf(':', 3);
    return sep < 0 ? null : blob.slice(3, sep);
  }
  return '0'; // legacy blob sealed under legacyId '0'
}

/** A column is already migrated iff it's null or already sealed under the primary. */
function onPrimary(blob) {
  return blob == null || sealingKeyId(blob) === keyring.primaryId;
}

async function main() {
  const client = await pool.connect();
  let scanned = 0;
  let updated = 0;
  try {
    const { rows } = await client.query('SELECT id, session_key_enc, gateway_token_enc FROM agents');
    for (const row of rows) {
      scanned += 1;
      if (onPrimary(row.session_key_enc) && onPrimary(row.gateway_token_enc)) continue; // already migrated
      const session = reencrypt(row.session_key_enc);
      const gateway = reencrypt(row.gateway_token_enc);
      await client.query('UPDATE agents SET session_key_enc = $2, gateway_token_enc = $3 WHERE id = $1', [
        row.id,
        session,
        gateway,
      ]);
      updated += 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`re-encrypt complete: scanned ${scanned} agents, re-wrote ${updated} onto primary id '${keyring.primaryId}'`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
