import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for LEASH-held scoped session keys (spec §5 custody note):
 * AES-256-GCM under a keyed ring. These are scoped keys only — they can act
 * solely within on-chain policy. The owner authority key never touches the backend.
 *
 * Inner blob (hex): iv(12B) || authTag(16B) || ciphertext.
 *
 * SCOPE-I-7 (key rotation): the inner blob is addressed by a keyring so the KEK
 * can be rotated without bricking existing agents. Two stored shapes:
 *   LEGACY    — pure hex `iv||tag||ct`, decrypted under key id '0'. This is the
 *               ONLY shape pre-rotation deployments ever wrote; emitting it
 *               byte-for-byte when no ring is configured keeps rollback safe.
 *   VERSIONED — ASCII `v1:<keyId>:<hexBlob>`, written once a ring is in use so
 *               `<keyId>` records which key sealed the blob (operator re-encrypts
 *               legacy/old-key blobs onto the new primary at rotation time).
 */
export interface Keyring {
  primaryId: string;                 // id used for NEW encryptions
  keys: ReadonlyMap<string, Buffer>; // id -> 32-byte key
  /** id whose key decrypts LEGACY (unversioned, pure-hex) blobs. Always '0'. */
  legacyId: string;
}

function loadKek(kekHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(kekHex)) {
    throw new Error('KEY_ENCRYPTION_SECRET must be 32 bytes of hex');
  }
  return Buffer.from(kekHex, 'hex');
}

/**
 * Build a validated keyring. Every key must be exactly 32 bytes (AES-256) and the
 * chosen primary/legacy ids must resolve; throw at wiring time, never on first use.
 */
export function buildKeyring(opts: {
  keys: Record<string, string>;      // id -> 64-hex KEK
  primaryId?: string;                // default '0'
  legacyId?: string;                 // default '0'
}): Keyring {
  const primaryId = opts.primaryId ?? '0';
  const legacyId = opts.legacyId ?? '0';
  const keys = new Map<string, Buffer>();
  for (const [id, hex] of Object.entries(opts.keys)) {
    keys.set(id, loadKek(hex)); // loadKek enforces the 32-byte (64-hex) shape
  }
  if (!keys.has(primaryId)) throw new Error(`keycrypt: primaryId '${primaryId}' not in keyring`);
  if (!keys.has(legacyId)) throw new Error(`keycrypt: legacyId '${legacyId}' not in keyring`);
  return { primaryId, keys, legacyId };
}

/** True when the ring is the single reserved default key (no rotation configured). */
function isDefaultOnly(keyring: Keyring): boolean {
  return keyring.keys.size === 1 && keyring.primaryId === '0' && keyring.legacyId === '0';
}

function sealHex(plaintext: string, kek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('hex');
}

function openHex(blobHex: string, kek: Buffer): string {
  const blob = Buffer.from(blobHex, 'hex');
  if (blob.length < 12 + 16 + 1) throw new Error('keycrypt: blob too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function encryptSecret(plaintext: string, keyring: Keyring): string {
  const kek = keyring.keys.get(keyring.primaryId);
  if (!kek) throw new Error(`keycrypt: primaryId '${keyring.primaryId}' not in keyring`);
  const hex = sealHex(plaintext, kek);
  // Rollback-safety invariant: a deployment with no ring writes the exact legacy
  // shape prod already stores. A configured ring records the sealing key id.
  return isDefaultOnly(keyring) ? hex : `v1:${keyring.primaryId}:${hex}`;
}

export function decryptSecret(blob: string, keyring: Keyring): string {
  if (blob.startsWith('v1:')) {
    const sep = blob.indexOf(':', 3);
    if (sep < 0) throw new Error('keycrypt: malformed v1 blob');
    const keyId = blob.slice(3, sep);
    const hex = blob.slice(sep + 1);
    const kek = keyring.keys.get(keyId);
    // Never silently fall back to a wrong key — an unknown id is a hard error.
    if (!kek) throw new Error(`keycrypt: no key for id '${keyId}'`);
    return openHex(hex, kek);
  }
  const kek = keyring.keys.get(keyring.legacyId);
  if (!kek) throw new Error(`keycrypt: no legacy key for id '${keyring.legacyId}'`);
  return openHex(blob, kek);
}
