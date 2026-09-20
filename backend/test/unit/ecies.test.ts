import { describe, it, expect } from 'vitest';
import { PrivateKey } from 'eciesjs';
import { eciesEncrypt, eciesDecrypt } from '../../src/crypto/ecies.js';

describe('ECIES audit encryption', () => {
  it('round-trips: encrypt to pubkey, decrypt with privkey', () => {
    const key = new PrivateKey();
    const pubHex = key.publicKey.toHex();
    const plaintext = Buffer.from('audit batch line 1\naudit batch line 2\n');
    const ct = eciesEncrypt(pubHex, plaintext);
    expect(ct.equals(plaintext)).toBe(false);
    const pt = eciesDecrypt(key.secret, ct);
    expect(pt.equals(plaintext)).toBe(true);
  });

  it('decrypt with the WRONG key fails', () => {
    const key = new PrivateKey();
    const wrong = new PrivateKey();
    const ct = eciesEncrypt(key.publicKey.toHex(), Buffer.from('secret audit data'));
    expect(() => eciesDecrypt(wrong.secret, ct)).toThrow();
  });

  it('accepts 0x-prefixed pubkeys', () => {
    const key = new PrivateKey();
    const ct = eciesEncrypt('0x' + key.publicKey.toHex(), Buffer.from('x'));
    expect(eciesDecrypt(key.secret, ct).toString()).toBe('x');
  });
});
