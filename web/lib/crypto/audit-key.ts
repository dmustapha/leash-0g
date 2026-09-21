// File: web/lib/crypto/audit-key.ts
// The agent's dedicated audit ECIES keypair (secp256k1), generated IN THE BROWSER at create.
// The privkey NEVER reaches the server in the clear: it is AES-GCM-wrapped by the owner KEK
// (see kek.ts) and stored as an opaque blob, plus offered as a download backup.

import { PrivateKey, decrypt as eciesDecrypt } from 'eciesjs';

export type AuditKeypair = {
  /** 32-byte privkey, hex without 0x. Keep client-side only. */
  privKeyHex: string;
  /** 65-byte uncompressed pubkey, hex without 0x — registered on-chain / with the backend. */
  pubKeyHex: string;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generateAuditKeypair(): AuditKeypair {
  const sk = new PrivateKey();
  return {
    privKeyHex: toHex(sk.secret),
    pubKeyHex: toHex(sk.publicKey.toBytes(false)),
  };
}

/** ECIES-decrypt an audit ciphertext batch, entirely client-side. */
export function decryptAuditCiphertext(privKeyHex: string, ciphertext: Uint8Array): Uint8Array {
  return new Uint8Array(eciesDecrypt(hexToBytes(privKeyHex) as Buffer | Uint8Array, ciphertext as Buffer | Uint8Array));
}

/**
 * C-6: the downloadable backup contains the ENCRYPTED blob only — never the
 * plaintext privkey. Pure builder so tests can pin the no-plaintext property.
 */
export function buildAuditBackup(input: {
  agentId: string;
  pubKeyHex: string;
  blob: { mode: 'signature' | 'passphrase' } & Record<string, unknown>;
}): string {
  return JSON.stringify(
    {
      warning:
        'Keep this file private. The encrypted blob plus your wallet signature (or passphrase) decrypts your entire agent audit trail.',
      agentId: input.agentId,
      auditPubKey: input.pubKeyHex,
      encryptedBlob: input.blob,
      kekMode: input.blob.mode,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );
}
