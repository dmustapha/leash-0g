// @vitest-environment node
// File: web/tests/crypto.test.ts
// (node env: eciesjs/@noble require same-realm Uint8Arrays; jsdom's TextEncoder breaks that.)
// KEK derivation (signature + passphrase, determinism guard) and the ECIES audit keypair
// round-trip — the exact client-side path used at create and at audit decrypt.
import { describe, expect, it } from 'vitest';
import { encrypt as eciesEncrypt } from 'eciesjs';
import {
  decryptBlob,
  encryptWithPassphrase,
  encryptWithSignature,
  parseBlob,
  probeDeterministicSignature,
  serializeBlob,
} from '@/lib/crypto/kek';
import {
  decryptAuditCiphertext,
  generateAuditKeypair,
  hexToBytes,
} from '@/lib/crypto/audit-key';

const SIG = '0x' + 'ab'.repeat(65);

describe('KEK', () => {
  it('signature mode round-trips through serialize/parse', async () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = await encryptWithSignature(secret, SIG);
    const restored = await decryptBlob(parseBlob(serializeBlob(blob)), SIG);
    expect(Array.from(restored)).toEqual([1, 2, 3, 4, 5]);
  });

  it('signature mode fails with a different signature', async () => {
    const blob = await encryptWithSignature(new Uint8Array([9]), SIG);
    await expect(decryptBlob(blob, '0x' + 'cd'.repeat(65))).rejects.toThrow();
  });

  it('passphrase mode round-trips and rejects a wrong passphrase', async () => {
    const blob = await encryptWithPassphrase(new Uint8Array([7, 7]), 'hunter22');
    expect(blob.mode).toBe('passphrase');
    expect(Array.from(await decryptBlob(blob, 'hunter22'))).toEqual([7, 7]);
    await expect(decryptBlob(blob, 'wrong')).rejects.toThrow();
  });

  it('determinism guard: deterministic wallet passes, non-deterministic returns null', async () => {
    expect(await probeDeterministicSignature(async () => SIG)).toBe(SIG);
    let i = 0;
    expect(await probeDeterministicSignature(async () => `0xsig${i++}`)).toBeNull();
  });
});

describe('audit ECIES keypair', () => {
  it('generates a keypair and decrypts what was encrypted to the pubkey', () => {
    const kp = generateAuditKeypair();
    expect(kp.pubKeyHex).toHaveLength(130); // uncompressed 65 bytes
    const plaintext = new TextEncoder().encode('{"seq":0,"kind":"inference"}\n');
    const ciphertext = eciesEncrypt(hexToBytes(kp.pubKeyHex), plaintext);
    const out = decryptAuditCiphertext(kp.privKeyHex, new Uint8Array(ciphertext));
    expect(new TextDecoder().decode(out)).toContain('"kind":"inference"');
  });

  it('a different privkey cannot decrypt', () => {
    const a = generateAuditKeypair();
    const b = generateAuditKeypair();
    const ct = eciesEncrypt(hexToBytes(a.pubKeyHex), new Uint8Array([1]));
    expect(() => decryptAuditCiphertext(b.privKeyHex, new Uint8Array(ct))).toThrow();
  });
});
