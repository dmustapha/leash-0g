import { encrypt, decrypt, PublicKey } from 'eciesjs';

/**
 * ECIES to the agent's dedicated audit pubkey (H-03): the backend only ever
 * ENCRYPTS — the privkey is owner-held and decryption is an owner-client
 * operation. eciesDecrypt exists for tests and the owner-side tooling only.
 */
export function eciesEncrypt(pubKeyHex: string, plaintext: Buffer): Buffer {
  const hex = pubKeyHex.replace(/^0x/, '');
  return Buffer.from(encrypt(hex, plaintext));
}

export function eciesDecrypt(privKey: Uint8Array, ciphertext: Buffer): Buffer {
  return Buffer.from(decrypt(privKey, ciphertext));
}

/**
 * F-3: a hex blob can match the pubkey REGEX (02/03+64 or 04+128) yet not be
 * a point on secp256k1 — eciesjs then throws "bad point: is not on curve" at
 * every flush. Validate the actual curve point, not just the shape.
 */
export function isValidEciesPubkey(pubKeyHex: string): boolean {
  try {
    new PublicKey(Buffer.from(pubKeyHex.replace(/^0x/, ''), 'hex'));
    return true;
  } catch {
    return false;
  }
}
