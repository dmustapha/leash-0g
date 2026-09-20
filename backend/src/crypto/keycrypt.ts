import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for LEASH-held scoped session keys (spec §5 custody note):
 * AES-256-GCM under KEY_ENCRYPTION_SECRET (32-byte hex from env). These are
 * scoped keys only — they can act solely within on-chain policy. The owner
 * authority key never touches the backend.
 *
 * Blob format (hex): iv(12B) || authTag(16B) || ciphertext.
 */
function loadKek(kekHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(kekHex)) {
    throw new Error('KEY_ENCRYPTION_SECRET must be 32 bytes of hex');
  }
  return Buffer.from(kekHex, 'hex');
}

export function encryptSecret(plaintext: string, kekHex: string): string {
  const kek = loadKek(kekHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('hex');
}

export function decryptSecret(blobHex: string, kekHex: string): string {
  const kek = loadKek(kekHex);
  const blob = Buffer.from(blobHex, 'hex');
  if (blob.length < 12 + 16 + 1) throw new Error('keycrypt: blob too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
