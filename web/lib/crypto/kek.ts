// File: web/lib/crypto/kek.ts
// Key-encryption-key (KEK) for the audit privkey. Two derivation modes (spec §5):
//  - 'signature': AES-GCM key HKDF-derived from a deterministic owner-wallet signature over an
//    owner+chain-bound message. RFC-6979 wallets sign deterministically; we derive TWICE and compare — if the
//    two signatures differ, the wallet is non-deterministic and we fall back to a passphrase.
//  - 'passphrase': PBKDF2 (310k iters, SHA-256) over a user passphrase + random salt.
// The KEK never leaves the browser; the server stores only the opaque encrypted blob.

/**
 * Sign message for KEK derivation, bound to the owner address + chain id (security M-01):
 * a signature phished on another site/chain, or from another account, derives a different
 * (useless) key. Address is lowercased so wallet checksum casing never changes the message.
 */
export function kekSignMessage(ownerAddress: string, chainId: number): string {
  return `LEASH audit key v2\nowner: ${ownerAddress.toLowerCase()}\nchain: ${chainId}\n\nSign this message to lock or unlock the private key that decrypts your audit trail. Signing is free and sends no transaction.`;
}

export type KekMode = 'signature' | 'passphrase';

export type EncryptedBlob = {
  v: 1;
  mode: KekMode;
  /** PBKDF2 salt (base64) — passphrase mode only. */
  salt?: string;
  /** AES-GCM IV (base64). */
  iv: string;
  /** ciphertext (base64). */
  ct: string;
};

const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hkdfKeyFromSignature(signature: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', enc.encode(signature), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('leash-audit-kek-v1'), info: enc.encode('aes-gcm-256') },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function pbkdf2Key(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 310_000 },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Determinism guard: sign the KEK message (kekSignMessage) twice and compare.
 * Returns the signature if deterministic, or null (→ caller must ask for a passphrase).
 */
export async function probeDeterministicSignature(
  signMessage: (message: string) => Promise<string>,
  message: string,
): Promise<string | null> {
  const a = await signMessage(message);
  const b = await signMessage(message);
  return a === b ? a : null;
}

export async function encryptWithSignature(
  plaintext: Uint8Array,
  signature: string,
): Promise<EncryptedBlob> {
  const key = await hkdfKeyFromSignature(signature);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { v: 1, mode: 'signature', iv: b64(iv), ct: b64(ct) };
}

export async function encryptWithPassphrase(
  plaintext: Uint8Array,
  passphrase: string,
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2Key(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { v: 1, mode: 'passphrase', salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Decrypt a blob. `unlock` is the signature (signature mode) or the passphrase. */
export async function decryptBlob(blob: EncryptedBlob, unlock: string): Promise<Uint8Array> {
  const key =
    blob.mode === 'signature'
      ? await hkdfKeyFromSignature(unlock)
      : await pbkdf2Key(unlock, unb64(blob.salt ?? ''));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.iv) as BufferSource },
    key,
    unb64(blob.ct) as BufferSource,
  );
  return new Uint8Array(pt);
}

export function serializeBlob(blob: EncryptedBlob): string {
  return JSON.stringify(blob);
}

export function parseBlob(s: string): EncryptedBlob {
  const j = JSON.parse(s) as EncryptedBlob;
  if (j.v !== 1 || !j.iv || !j.ct || (j.mode !== 'signature' && j.mode !== 'passphrase')) {
    throw new Error('Unrecognized audit key backup format');
  }
  return j;
}
