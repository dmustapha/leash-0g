import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/crypto/keycrypt.js';

const KEK = 'ab'.repeat(32); // 32-byte hex test key

describe('keycrypt (AES-256-GCM at-rest encryption)', () => {
  it('round-trips a session private key', () => {
    const pk = '0x' + '7e'.repeat(32);
    const blob = encryptSecret(pk, KEK);
    expect(blob).not.toContain(pk.slice(2));
    expect(decryptSecret(blob, KEK)).toBe(pk);
  });

  it('produces distinct ciphertexts per call (random IV)', () => {
    const pk = '0x' + '7e'.repeat(32);
    expect(encryptSecret(pk, KEK)).not.toBe(encryptSecret(pk, KEK));
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptSecret('secret-material', KEK);
    expect(() => decryptSecret(blob, 'cd'.repeat(32))).toThrow();
  });

  it('fails on tampered ciphertext', () => {
    const blob = encryptSecret('secret-material', KEK);
    const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? '11' : '00');
    expect(() => decryptSecret(tampered, KEK)).toThrow();
  });

  it('rejects a KEK that is not 32 bytes of hex', () => {
    expect(() => encryptSecret('x', 'deadbeef')).toThrow();
  });
});
