// File: web/tests/audit-view.test.tsx
// AuditView anchored verification: decrypted batches thread expectedPrev — a batch chain
// starting at seq 0 reads "verified from genesis"; a mid-chain slice with no prior batch
// reads "verified (slice only)". WebCrypto/ECIES are mocked (see crypto.test.ts for those);
// the hash-chain math is real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GENESIS_HASH, recordHash } from '@/lib/hash-chain';
import type { AuditBatch, Hex, TraceRecord } from '@/lib/types';

const decrypted = vi.hoisted(() => ({ value: new Uint8Array() }));

vi.mock('@/lib/crypto/kek', () => ({
  kekSignMessage: (owner: string, chainId: number) => `msg:${owner}:${chainId}`,
  parseBlob: (s: string) => JSON.parse(s) as unknown,
  decryptBlob: vi.fn(async () => new Uint8Array([0xaa, 0xbb])),
}));

vi.mock('@/lib/crypto/audit-key', () => ({
  decryptAuditCiphertext: () => decrypted.value,
}));

import { AuditView } from '@/components/audit/AuditView';

const OWNER = '0x3333333333333333333333333333333333333333' as const;
const STORED_BLOB = JSON.stringify({ v: 1, mode: 'signature', iv: 'aa', ct: 'bb' });

function makeChain(n: number): TraceRecord[] {
  const records: TraceRecord[] = [];
  let prev: Hex = GENESIS_HASH;
  for (let seq = 0; seq < n; seq++) {
    const body = {
      agentId: 'agent-1',
      seq,
      prevHash: prev,
      ts: `2026-09-20T00:00:0${seq}Z`,
      kind: 'inference' as const,
      response: { text: `thought ${seq}` },
    };
    const hash = recordHash(body);
    records.push({ ...body, hash });
    prev = hash;
  }
  return records;
}

function batch(batchId: string, seqFrom: number, seqTo: number): AuditBatch {
  return {
    batchId,
    seqFrom,
    seqTo,
    merkleRoot: `0x${'11'.repeat(32)}` as Hex,
    storageTx: `0x${'22'.repeat(32)}` as Hex,
    ciphertextUrl: `https://storage.example/${batchId}`,
  };
}

function setDecrypted(records: TraceRecord[]) {
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n');
  decrypted.value = new TextEncoder().encode(jsonl);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
  );
});

async function renderAndUnlock(batches: AuditBatch[]) {
  const user = userEvent.setup();
  render(
    <AuditView
      batches={batches}
      storedBlob={STORED_BLOB}
      signMessage={async () => '0xsig'}
      ownerAddress={OWNER}
    />,
  );
  await user.click(screen.getByTestId('unlock-btn'));
  await screen.findByTestId('key-unlocked');
  return user;
}

describe('AuditView anchored verification', () => {
  it('a batch starting at seq 0 shows "verified from genesis"', async () => {
    const chain = makeChain(3);
    const user = await renderAndUnlock([batch('b1', 0, 2)]);
    setDecrypted(chain);
    await user.click(screen.getByRole('button', { name: /decrypt & view/i }));
    const pill = await screen.findByTestId('chain-ok');
    expect(pill).toHaveTextContent(/verified from genesis/i);
  });

  it('threads the anchor: the second batch stays genesis-verified', async () => {
    const chain = makeChain(5);
    const user = await renderAndUnlock([batch('b1', 0, 2), batch('b2', 3, 4)]);
    setDecrypted(chain.slice(0, 3));
    const buttons = screen.getAllByRole('button', { name: /decrypt & view/i });
    await user.click(buttons[0]!);
    await screen.findByTestId('chain-ok');
    setDecrypted(chain.slice(3, 5));
    await user.click(buttons[1]!);
    const pill = await screen.findByTestId('chain-ok');
    expect(pill).toHaveTextContent(/verified from genesis/i);
  });

  it('a mid-chain batch with no prior batch shows "verified (slice only)"', async () => {
    const chain = makeChain(5);
    const user = await renderAndUnlock([batch('b2', 3, 4)]);
    setDecrypted(chain.slice(3, 5));
    await user.click(screen.getByRole('button', { name: /decrypt & view/i }));
    const pill = await screen.findByTestId('chain-ok');
    expect(pill).toHaveTextContent(/verified \(slice only\)/i);
  });
});
