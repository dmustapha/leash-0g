import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, buildKeyring } from '../../src/crypto/keycrypt.js';

const KEY_A = 'ab'.repeat(32); // id '0'
const KEY_B = 'cd'.repeat(32); // id '1'
const PK = '0x' + '11'.repeat(32);

const defaultRing = buildKeyring({ keys: { '0': KEY_A } });
const rotatedRing = buildKeyring({ keys: { '0': KEY_A, '1': KEY_B }, primaryId: '1' });

describe('keycrypt rollback-safety', () => {
  it('default keyring writes LEGACY format (no v1: prefix)', () => {
    const blob = encryptSecret(PK, defaultRing);
    expect(blob.startsWith('v1:')).toBe(false);
    expect(/^[0-9a-f]+$/.test(blob)).toBe(true);
  });

  it('legacy round-trip: a legacy blob decrypts under the default keyring', () => {
    const legacy = encryptSecret(PK, defaultRing);
    expect(legacy.startsWith('v1:')).toBe(false);
    expect(decryptSecret(legacy, defaultRing)).toBe(PK);
  });

  it('uses a fresh IV per encryption (no deterministic reuse)', () => {
    expect(encryptSecret(PK, defaultRing)).not.toBe(encryptSecret(PK, defaultRing));
  });
});

describe('keycrypt rotation', () => {
  it('configured keyring writes v1:<primaryId>: format', () => {
    const blob = encryptSecret(PK, rotatedRing);
    expect(blob.startsWith('v1:1:')).toBe(true);
    expect(decryptSecret(blob, rotatedRing)).toBe(PK);
  });

  it('old blobs still decrypt after rotation (old key retained)', () => {
    // A legacy blob sealed before rotation (under key A, id '0').
    const legacy = encryptSecret(PK, defaultRing);
    // A versioned blob that named key '0' explicitly.
    const v0 = encryptSecret(PK, buildKeyring({ keys: { '0': KEY_A, '1': KEY_B }, primaryId: '0' }));
    expect(v0.startsWith('v1:0:')).toBe(true);
    // The rotated ring (primary '1') still decrypts both — both keys are retained.
    expect(decryptSecret(legacy, rotatedRing)).toBe(PK);
    expect(decryptSecret(v0, rotatedRing)).toBe(PK);
  });

  it('a v1 blob with an unknown keyId throws (never silent wrong-key)', () => {
    const blob = encryptSecret(PK, rotatedRing); // v1:1:...
    const ringWithout1 = buildKeyring({ keys: { '0': KEY_A } });
    expect(() => decryptSecret(blob, ringWithout1)).toThrow(/no key for id/);
  });
});

describe('keycrypt integrity', () => {
  it('tampered ciphertext throws (GCM auth tag)', () => {
    const blob = encryptSecret('secret-material', defaultRing);
    const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? '11' : '00');
    expect(() => decryptSecret(tampered, defaultRing)).toThrow();
  });
});

describe('buildKeyring validation', () => {
  it('rejects a primaryId not in keys', () => {
    expect(() => buildKeyring({ keys: { '0': KEY_A }, primaryId: '9' })).toThrow(/primaryId/);
  });

  it('rejects a non-32-byte key', () => {
    expect(() => buildKeyring({ keys: { '0': 'deadbeef' } })).toThrow();
  });
});
