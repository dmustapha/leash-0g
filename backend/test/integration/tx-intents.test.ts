import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { SendLane, type LaneTransport } from '../../src/runtime/tx-intents/lane.js';
import { TxInFlightError, TxNeedsReviewError } from '../../src/runtime/tx-intents/errors.js';
import { ReceiptUnconfirmedError } from '../../src/chain/wait-receipt.js';

/**
 * AQ-FND S1 (WP-F) — the intent ledger + send lane, proven against a FAULT-INJECTING fake chain.
 * Every property here is a "never pays twice / never loses the handle" property; each has a
 * mutation check recorded in the S1 notes (mutate the lane, watch the test fail).
 */

/** A tiny EVM-ish chain: nonces, a mempool, mining on demand, and injectable faults. */
class FakeChain implements LaneTransport {
  readonly chainId = 31337;
  confirmed = new Map<string, bigint>(); // addr -> next nonce (mined count)
  mempool = new Map<string, { from: string; nonce: bigint; raw: Hex }>();
  mined = new Map<string, { status: 'success' | 'reverted'; blockNumber: bigint; raw: Hex; from: string; nonce: bigint }>();
  sent: Hex[] = []; // every raw tx the chain ever ACCEPTED (distinct hashes)
  block = 100n;
  // faults
  estimateError: Error | null = null;
  hideReceipts = 0; // number of getReceipt calls to answer null even if mined
  sendThrowsAfterAccept = false; // accept the tx but throw to the caller (lost response)
  sendThrowsBeforeAccept = false; // reject before the chain sees it (crash before broadcast)
  autoMine = true; // mine on accept

  private nonceOf(addr: string): bigint { return this.confirmed.get(addr.toLowerCase()) ?? 0n; }
  async getPendingNonce(addr: string): Promise<bigint> {
    const inPool = [...this.mempool.values()].filter((t) => t.from === addr.toLowerCase()).length;
    return this.nonceOf(addr) + BigInt(inPool);
  }
  async getLatestNonce(addr: string): Promise<bigint> { return this.nonceOf(addr); }
  async estimate(): Promise<{ gas: bigint }> {
    if (this.estimateError) throw this.estimateError;
    return { gas: 100_000n };
  }
  feeNow = 2_000_000_000n;
  async feeData() { return { maxFeePerGas: this.feeNow, maxPriorityFeePerGas: this.feeNow / 2n }; }
  async sendRaw(raw: Hex): Promise<Hex> {
    if (this.sendThrowsBeforeAccept) { this.sendThrowsBeforeAccept = false; throw new Error('connection reset (crash before broadcast)'); }
    const hash = keccak256(raw);
    if (this.mempool.has(hash) || this.mined.has(hash)) throw new Error('already known');
    const parsed = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    const nonce = BigInt(parsed.nonce ?? 0);
    if (nonce < this.nonceOf(from)) throw new Error('nonce too low');
    // same-nonce replacement needs a >= 10% fee bump (real node behaviour)
    for (const [h, t] of this.mempool) {
      if (t.from === from && t.nonce === nonce && h !== hash) {
        const oldFee = BigInt(parseTransaction(t.raw).maxFeePerGas ?? 0n);
        const newFee = BigInt(parsed.maxFeePerGas ?? 0n);
        if (newFee * 100n < oldFee * 110n) throw new Error('replacement transaction underpriced');
        this.mempool.delete(h);
      }
    }
    this.mempool.set(hash, { from, nonce, raw });
    this.sent.push(raw);
    if (this.autoMine) this.mine(hash);
    if (this.sendThrowsAfterAccept) { this.sendThrowsAfterAccept = false; throw new Error('timeout waiting for response (tx WAS accepted)'); }
    return hash;
  }
  mine(hash: Hex, status: 'success' | 'reverted' = 'success') {
    const t = this.mempool.get(hash);
    if (!t) return;
    this.mempool.delete(hash);
    this.confirmed.set(t.from, t.nonce + 1n);
    this.block += 1n;
    this.mined.set(hash, { status, blockNumber: this.block, raw: t.raw, from: t.from, nonce: t.nonce });
  }
  drop(hash: Hex) { this.mempool.delete(hash); }
  /** Another writer (not us) consumes `nonce` for `addr`. */
  injectExternal(addr: string, nonce: bigint) {
    this.confirmed.set(addr.toLowerCase(), nonce + 1n);
  }
  async getReceipt(hash: Hex) {
    if (this.hideReceipts > 0) { this.hideReceipts -= 1; return null; }
    const m = this.mined.get(hash);
    return m ? { status: m.status, blockNumber: m.blockNumber } : null;
  }
  async getBlockNumber() { return this.block; }
}

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.drop(); });

const KEY = generatePrivateKey();
const KEY_ADDR = privateKeyToAccount(KEY).address.toLowerCase();
const ACCOUNT = '0x' + 'ac'.repeat(20);
const TO = '0x' + 'be'.repeat(20);

let chain: FakeChain;
let lane: SendLane;
let seq = 0;
const agent = () => `agent-${++seq}`;

beforeEach(async () => {
  await db.pool.query('TRUNCATE tx_intents');
  chain = new FakeChain();
  // grace models 0G receipt-indexing lag: a consumed nonce with no receipt is NOT an outsider yet
  lane = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000 });
});

const req = (agentId: string, idemKey: string, over: Record<string, unknown> = {}) => ({
  agentId,
  sessionPrivateKey: KEY,
  accountAddr: ACCOUNT,
  kind: 'token_transfer' as const,
  idemKey,
  to: ACCOUNT as Hex,
  data: '0xdeadbeef' as Hex,
  value: 0n,
  payload: { token: '0xtoken', to: TO, amount: '1000000' },
  ...over,
});
const rows = async (agentId: string) => (await db.pool.query(`SELECT * FROM tx_intents WHERE agent_id=$1 ORDER BY created_at`, [agentId])).rows;

describe('SendLane — write-ahead, idempotent, single-lane', () => {
  it('happy path: persists intent, broadcasts once, ends mined with the hash', async () => {
    const a = agent();
    const r = await lane.send(req(a, 'k1'));
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.sent).toHaveLength(1);
    const [row] = await rows(a);
    expect(row.status).toBe('mined');
    expect(row.tx_hash).toBe(r.txHash);
    expect(row.raw_tx).toBe(chain.sent[0]);
    expect(BigInt(row.nonce)).toBe(0n);
  });

  it('idempotent: the same (agent, idemKey) never sends a second tx', async () => {
    const a = agent();
    const r1 = await lane.send(req(a, 'same'));
    const r2 = await lane.send(req(a, 'same'));
    expect(r2.txHash).toBe(r1.txHash);
    expect(chain.sent).toHaveLength(1);
    expect(await rows(a)).toHaveLength(1);
  });

  it('crash BEFORE broadcast: the signed bytes are already persisted; reconcile re-sends the SAME bytes once', async () => {
    const a = agent();
    chain.sendThrowsBeforeAccept = true;
    await expect(lane.send(req(a, 'c1'))).rejects.toThrow();
    const [signed] = await rows(a);
    expect(signed.status).toBe('signed');
    expect(signed.raw_tx).toMatch(/^0x/);
    expect(chain.sent).toHaveLength(0);
    // a fresh process boots and reconciles
    const lane2 = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 0 });
    await lane2.reconcile();
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toBe(signed.raw_tx); // identical bytes, never a rebuilt tx
    expect((await rows(a))[0].status).toBe('mined');
  });

  it('lost response AFTER the chain accepted the tx: no second tx is ever built', async () => {
    const a = agent();
    chain.sendThrowsAfterAccept = true;
    await lane.send(req(a, 'c2')).catch(() => undefined);
    await lane.reconcile();
    expect(chain.sent).toHaveLength(1);
    expect((await rows(a))[0].status).toBe('mined');
    // and a retry of the same logical send is still a no-op
    await lane.send(req(a, 'c2')).catch(() => undefined);
    expect(chain.sent).toHaveLength(1);
  });

  it('null receipt is "unknown", never "failed": ambiguous error, then the lane is busy until reconciled', async () => {
    const a = agent();
    chain.hideReceipts = 1000;
    await expect(lane.send(req(a, 'n1'))).rejects.toBeInstanceOf(ReceiptUnconfirmedError);
    expect((await rows(a))[0].status).toBe('broadcast');
    // a NEW logical send while the first is unresolved must not go out
    await expect(lane.send(req(a, 'n2'))).rejects.toBeInstanceOf(TxInFlightError);
    expect(chain.sent).toHaveLength(1);
    // the receipt becomes visible; reconcile resolves it; now the lane is free
    chain.hideReceipts = 0;
    await lane.reconcile();
    expect((await rows(a))[0].status).toBe('mined');
    const r = await lane.send(req(a, 'n2'));
    expect(r.txHash).toMatch(/^0x/);
    expect(chain.sent).toHaveLength(2);
  });

  it('dropped tx: reconcile re-broadcasts the same raw bytes (same nonce), exactly one tx lands', async () => {
    const a = agent();
    chain.autoMine = false;
    const p = lane.send(req(a, 'd1')).catch((e: unknown) => e); // will not mine -> ambiguous
    const res = await p;
    expect(res).toBeInstanceOf(ReceiptUnconfirmedError);
    const hash = (await rows(a))[0].tx_hash as Hex;
    chain.drop(hash); // the network forgot it
    chain.autoMine = true;
    await lane.reconcile();
    expect(chain.mined.size).toBe(1);
    // the SAME bytes were re-sent (identical hash), never a rebuilt tx
    expect(new Set(chain.sent.map((r) => keccak256(r))).size).toBe(1);
    expect(chain.sent.every((r) => keccak256(r) === hash)).toBe(true);
    expect((await rows(a))[0].status).toBe('mined');
  });

  it('"already known" on re-broadcast is reconciled, not rebuilt', async () => {
    const a = agent();
    chain.autoMine = false;
    await lane.send(req(a, 'k2')).catch(() => undefined); // in mempool, no receipt yet
    await lane.reconcile(); // re-broadcast hits "already known" -> must stay broadcast
    expect(chain.sent).toHaveLength(1);
    const [row] = await rows(a);
    expect(row.status).toBe('broadcast');
    chain.mine(row.tx_hash as Hex);
    await lane.reconcile();
    expect((await rows(a))[0].status).toBe('mined');
  });

  it('two concurrent senders on one key are serialized: distinct, consecutive nonces, no collision', async () => {
    const a = agent();
    const [r1, r2] = await Promise.all([lane.send(req(a, 'p1')), lane.send(req(a, 'p2', { payload: { amount: '2' } }))]);
    expect(r1.txHash).not.toBe(r2.txHash);
    const nonces = (await rows(a)).map((r) => BigInt(r.nonce)).sort();
    expect(nonces).toEqual([0n, 1n]);
    expect(chain.sent).toHaveLength(2);
  });

  it('nonce consumed by an UNKNOWN tx: needs_review, never auto-retried, lane stays blocked', async () => {
    const a = agent();
    chain.autoMine = false;
    await lane.send(req(a, 'x1')).catch(() => undefined);
    const hash = (await rows(a))[0].tx_hash as Hex;
    chain.drop(hash);
    chain.injectExternal(KEY_ADDR, 0n); // someone else used nonce 0
    const strict = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 0 });
    await strict.reconcile();
    expect((await rows(a))[0].status).toBe('needs_review');
    expect(chain.sent).toHaveLength(1); // no rebroadcast
    await expect(strict.send(req(a, 'x2'))).rejects.toBeInstanceOf(TxNeedsReviewError);
  });

  it('a doomed tx (simulation reverts) is never broadcast and is recorded as failed', async () => {
    const a = agent();
    chain.estimateError = new Error('execution reverted: OverPerTransferCap');
    await expect(lane.send(req(a, 'f1'))).rejects.toThrow(/OverPerTransferCap/);
    expect(chain.sent).toHaveLength(0);
    const [row] = await rows(a);
    expect(row.status).toBe('failed');
    expect(row.error_class).toBe('permanent');
  });

  it('getInFlight reports un-mined amounts for an agent', async () => {
    const a = agent();
    chain.autoMine = false;
    await lane.send(req(a, 'i1')).catch(() => undefined);
    const f = await lane.getInFlight(a);
    expect(f.count).toBe(1);
    const hash = (await rows(a))[0].tx_hash as Hex;
    chain.mine(hash);
    await lane.reconcile();
    expect((await lane.getInFlight(a)).count).toBe(0);
  });

  describe('stuck tx: replace at the SAME nonce with a higher fee (never a new nonce)', () => {
    const bumpLane = () => new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, maxRebroadcasts: 1, bumpAfterMs: 0, getSessionKey: async () => KEY });

    it('after the rebroadcast budget, a fee-bumped replacement goes out at the same nonce and one tx lands', async () => {
      const a = agent();
      const bl = bumpLane();
      chain.autoMine = false;
      await bl.send(req(a, 'b1')).catch(() => undefined);
      const first = (await rows(a))[0];
      await bl.reconcile(); // rebroadcast #1 (same bytes)
      chain.feeNow = 5_000_000_000n; // the market moved: the old fee is now too cheap
      await bl.reconcile(); // budget spent -> bump
      const row = (await rows(a))[0];
      expect(row.tx_hash).not.toBe(first.tx_hash);
      expect(BigInt(row.nonce)).toBe(BigInt(first.nonce)); // same nonce
      expect(row.prev_hashes).toContain(first.tx_hash);
      expect(chain.mempool.size).toBe(1); // the old one was REPLACED, not duplicated
      chain.mine(row.tx_hash as Hex);
      await bl.reconcile();
      expect((await rows(a))[0].status).toBe('mined');
      expect(chain.mined.size).toBe(1);
    });

    it('if the OLD hash mines after a bump, that receipt is still recognised (no false needs_review)', async () => {
      const a = agent();
      const bl = bumpLane();
      chain.autoMine = false;
      await bl.send(req(a, 'b2')).catch(() => undefined);
      const first = (await rows(a))[0];
      await bl.reconcile();
      chain.feeNow = 5_000_000_000n;
      await bl.reconcile(); // bumped
      // the network actually mined the ORIGINAL bytes (race): re-inject it as mined
      chain.mempool.delete((await rows(a))[0].tx_hash as Hex);
      chain.mempool.set(first.tx_hash as Hex, { from: KEY_ADDR, nonce: 0n, raw: first.raw_tx as Hex });
      chain.mine(first.tx_hash as Hex);
      await new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 0, maxRebroadcasts: 1, bumpAfterMs: 0, getSessionKey: async () => KEY }).reconcile();
      const row = (await rows(a))[0];
      expect(row.status).toBe('mined');
      expect(row.tx_hash).toBe(first.tx_hash);
    });

    it('after the bump budget is spent it asks a human (needs_review) and notifies', async () => {
      const a = agent();
      const seen: string[] = [];
      const bl = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, maxRebroadcasts: 1, bumpAfterMs: 0, maxBumps: 1, getSessionKey: async () => KEY, onNeedsReview: (r) => { seen.push(r.intentId); } });
      chain.autoMine = false;
      await bl.send(req(a, 'b3')).catch(() => undefined);
      await bl.reconcile(); // rebroadcast
      chain.feeNow = 5_000_000_000n; await bl.reconcile(); // bump #1
      chain.feeNow = 10_000_000_000n; await bl.reconcile(); // rebroadcast of the bumped tx
      chain.feeNow = 20_000_000_000n; await bl.reconcile(); // budget spent
      expect((await rows(a))[0].status).toBe('needs_review');
      expect(seen).toHaveLength(1);
    });
  });
});
