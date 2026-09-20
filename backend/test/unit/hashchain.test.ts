import { describe, it, expect } from 'vitest';
import { GENESIS_HASH, computeRecordHash, verifyChain } from '../../src/crypto/hashchain.js';

function makeChain(n: number) {
  const records = [];
  let prev = GENESIS_HASH;
  for (let seq = 0; seq < n; seq++) {
    const body = { agentId: 'a1', seq, prevHash: prev, ts: `2026-09-20T00:00:0${seq}Z`, kind: 'inference' as const };
    const hash = computeRecordHash(prev, body);
    records.push({ ...body, hash });
    prev = hash;
  }
  return records;
}

describe('hashchain', () => {
  it('computes a 32-byte hex hash', () => {
    const h = computeRecordHash(GENESIS_HASH, { agentId: 'a', seq: 0 });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hash depends on prevHash', () => {
    const body = { agentId: 'a', seq: 0 };
    const h1 = computeRecordHash(GENESIS_HASH, body);
    const h2 = computeRecordHash('0x' + '11'.repeat(32), body);
    expect(h1).not.toBe(h2);
  });

  it('verifies a valid chain', () => {
    const res = verifyChain(makeChain(5));
    expect(res.ok).toBe(true);
  });

  it('verifies the empty chain', () => {
    expect(verifyChain([]).ok).toBe(true);
  });

  it('rejects a mutated record', () => {
    const chain = makeChain(5);
    const target = chain[2];
    if (!target) throw new Error('missing');
    (target as { kind: string }).kind = 'action';
    const res = verifyChain(chain);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badSeq).toBe(2);
  });

  it('rejects a seq gap', () => {
    const chain = makeChain(5);
    chain.splice(2, 1);
    const res = verifyChain(chain);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badSeq).toBe(3);
  });

  it('rejects a wrong prevHash link', () => {
    const chain = makeChain(3);
    const target = chain[1];
    if (!target) throw new Error('missing');
    target.prevHash = '0x' + 'ab'.repeat(32);
    expect(verifyChain(chain).ok).toBe(false);
  });

  it('rejects a chain not starting at seq 0 from genesis', () => {
    const chain = makeChain(3).slice(1);
    expect(verifyChain(chain).ok).toBe(false);
    // but verifies when given the correct starting prev hash
    const full = makeChain(3);
    const first = full[0];
    if (!first) throw new Error('missing');
    expect(verifyChain(full.slice(1), { expectFirstSeq: 1, expectPrevHash: first.hash }).ok).toBe(true);
  });
});
