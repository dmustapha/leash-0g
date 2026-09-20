import { encrypt, decrypt } from 'eciesjs';

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
