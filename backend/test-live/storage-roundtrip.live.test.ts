// LIVE: encrypted 0G Storage round-trip (spec §7 "0G integration" row,
// kickoff condition ii): write → download → decrypt-as-owner asserts
// equality, and decrypt WITHOUT the owner privkey FAILS.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrivateKey } from 'eciesjs';
import { ZeroGStorage } from '../src/audit/storage.js';
import { eciesEncrypt, eciesDecrypt } from '../src/crypto/ecies.js';
import { requireEnv, retry } from './helpers.js';

describe('0G Storage encrypted round-trip (live testnet)', () => {
  it('uploads ciphertext, downloads it back, owner decrypts, wrong key fails', async () => {
    const storage = new ZeroGStorage({
      indexerUrl: requireEnv('ZERO_G_STORAGE_INDEXER'),
      rpcUrl: requireEnv('ZERO_G_RPC'),
      opsPrivateKey: requireEnv('OPS_PRIVATE_KEY'),
    });

    const ownerKey = new PrivateKey(); // dedicated audit keypair, never the wallet key (H-03)
    // unique payload every run — 0G Storage content-addresses by Merkle root,
    // re-uploading identical bytes collides with the existing root
    const plaintext = Buffer.from(
      [
        JSON.stringify({ agentId: 'live-test', seq: 0, kind: 'decision', nonce: randomUUID() }),
        JSON.stringify({ agentId: 'live-test', seq: 1, kind: 'action', ts: new Date().toISOString() }),
      ].join('\n'),
      'utf8',
    );
    const ciphertext = eciesEncrypt(ownerKey.publicKey.toHex(), plaintext);

    const { root, txHash } = await storage.upload(ciphertext);
    console.log(`0G Storage upload: root=${root} tx=${txHash}`);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(txHash).toMatch(/^0x/);

    // storage-node sync can lag the tx — retry the download
    const downloaded = await retry(() => storage.download(root), 6, 5_000);
    expect(downloaded.equals(ciphertext)).toBe(true);

    // owner decrypt recovers the exact plaintext
    const decrypted = eciesDecrypt(ownerKey.secret, downloaded);
    expect(decrypted.equals(plaintext)).toBe(true);

    // decrypt WITHOUT the owner privkey must fail
    const wrongKey = new PrivateKey();
    expect(() => eciesDecrypt(wrongKey.secret, downloaded)).toThrow();
  });
});
