import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { SendLane, type LaneTransport } from '../../src/runtime/tx-intents/lane.js';
import { TxInFlightError, TxNeedsReviewError } from '../../src/runtime/tx-intents/errors.js';
import { ReceiptUnconfirmedError } from '../../src/chain/wait-receipt.js';
import { SessionChain } from '../../src/runtime/session-chain.js';

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
  async estimate(_req?: unknown): Promise<{ gas: bigint }> {
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

  describe('Gate-2 fixes: the ledger can never wedge an agent', () => {
    it('B-1: a throw between INSERT and the signed UPDATE marks the row failed (never a phantom in-flight)', async () => {
      const a = agent();
      const orig = chain.getPendingNonce.bind(chain);
      chain.getPendingNonce = async () => { throw new Error('HTTP request failed: 503'); };
      await expect(lane.send(req(a, 'w1'))).rejects.toThrow(/503/);
      chain.getPendingNonce = orig;
      const [row] = await rows(a);
      expect(row.status).toBe('failed');
      expect(row.error_class).toBe('transient');
      expect((await lane.getInFlight(a)).count).toBe(0);
      // and the same logical action can be retried: a transient failure is re-claimable
      const r = await lane.send(req(a, 'w1'));
      expect(r.txHash).toMatch(/^0x/);
      expect(chain.sent).toHaveLength(1);
    });

    it('B-1: an orphan intent row (process died after INSERT) is swept to failed by reconcile and stops counting as in flight', async () => {
      const a = agent();
      await db.pool.query(
        `INSERT INTO tx_intents (intent_id, agent_id, chain_id, key_addr, account_addr, kind, idem_key, payload, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'token_transfer', 'orphan', '{"amount":"5"}'::jsonb, 'intent', now() - interval '10 minutes')`,
        [a, chain.chainId, KEY_ADDR, ACCOUNT],
      );
      expect((await lane.getInFlight(a)).count).toBe(0); // an old orphan is not "in flight"
      await lane.reconcile();
      expect((await rows(a))[0].status).toBe('failed');
    });

    it('M-4: a send the node rejects for a lasting reason (cannot afford gas) is failed at once, not left signed forever', async () => {
      const a = agent();
      const orig = chain.sendRaw.bind(chain);
      chain.sendRaw = async () => { throw new Error('insufficient funds for gas * price + value'); };
      await expect(lane.send(req(a, 'ins1'))).rejects.toThrow(/insufficient funds/);
      chain.sendRaw = orig;
      expect((await rows(a))[0].status).toBe('failed');
      expect((await lane.getInFlight(a)).count).toBe(0);
    });

    it('M-4: a tx that stays signed-but-never-accepted past the stale limit is escalated to a human, never resent on old balances', async () => {
      const a = agent();
      chain.sendThrowsBeforeAccept = true;
      await lane.send(req(a, 'st1')).catch(() => undefined);
      await db.pool.query(`UPDATE tx_intents SET updated_at = now() - interval '30 minutes' WHERE agent_id=$1`, [a]);
      const seen: string[] = [];
      const l2 = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, onNeedsReview: (r) => { seen.push(r.reason); } });
      chain.sendRaw = async () => { throw new Error('transaction underpriced'); }; // refused for good (the old fee is dead)
      await l2.reconcile();
      expect((await rows(a))[0].status).toBe('needs_review');
      expect(chain.sent).toHaveLength(0);
      expect(seen).toHaveLength(1);
    });

    it('M-6: a reverted tx still holds its nonce: the next send never reuses it, even if the RPC lags', async () => {
      const a = agent();
      chain.autoMine = false;
      await lane.send(req(a, 'rv1')).catch(() => undefined);
      const h = (await rows(a))[0].tx_hash as Hex;
      chain.mine(h, 'reverted');
      await lane.reconcile();
      expect((await rows(a))[0].status).toBe('reverted');
      chain.autoMine = true;
      // a lagging RPC claims the nonce is still 0
      const lagging = Object.create(chain) as FakeChain;
      lagging.getPendingNonce = async () => 0n;
      const lag = new SendLane({ pool: db.pool, transport: lagging, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000 });
      await lag.send(req(a, 'rv2')).catch(() => undefined);
      const second = (await rows(a)).find((r) => r.idem_key === 'rv2');
      expect(BigInt(second.nonce)).toBe(1n); // not 0
    });

    it('M-9: two reconcilers racing to bump one stuck tx cannot lose a replacement hash', async () => {
      const a = agent();
      const mk2 = () => new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, maxRebroadcasts: 0, bumpAfterMs: 0, getSessionKey: async () => KEY });
      chain.autoMine = false;
      await mk2().send(req(a, 'race')).catch(() => undefined);
      chain.feeNow = 6_000_000_000n;
      await Promise.all([mk2().reconcile(), mk2().reconcile()]);
      const row = (await rows(a))[0];
      // every hash that ever existed for this nonce is recorded, and the live one is in the mempool
      const known = new Set([row.tx_hash, ...row.prev_hashes]);
      for (const h of chain.mempool.keys()) expect(known.has(h)).toBe(true);
      expect(row.status).not.toBe('needs_review');
    });

    it('two lane INSTANCES (as if two processes) racing on one key: the DATABASE lets only one un-mined tx exist', async () => {
      const a = agent();
      chain.autoMine = false;
      const l1 = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 60_000, receiptGraceMs: 60_000 });
      const l2 = new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 60_000, receiptGraceMs: 60_000 });
      const settled = await Promise.allSettled([l1.send(req(a, 'x-a')), l2.send(req(a, 'x-b'))]);
      const unmined = (await db.pool.query(`SELECT count(*)::int c FROM tx_intents WHERE key_addr=$1 AND status IN ('signed','broadcast')`, [KEY_ADDR])).rows[0].c;
      expect(unmined).toBeLessThanOrEqual(1);
      expect(chain.sent.length).toBeLessThanOrEqual(1);
      void settled;
    });

    it('B-2: the lane asks the transport to simulate WITH the contract call (so a revert can be decoded)', async () => {
      const a = agent();
      let seenSim: unknown;
      const spy = Object.create(chain) as FakeChain;
      spy.estimate = async (r: { sim?: unknown }) => { seenSim = r.sim; return { gas: 100_000n }; };
      const l = new SendLane({ pool: db.pool, transport: spy, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000 });
      await l.send(req(a, 'sim1', { sim: { abi: [], functionName: 'executeTokenTransfer', args: [1] } }));
      expect(seenSim).toEqual({ abi: [], functionName: 'executeTokenTransfer', args: [1] });
    });
  });

  describe('SessionChain.viaLane (the real production path, not a fake)', () => {
    it('a token transfer with a send ctx goes through the ledger with the encoded call and a simulation hint', async () => {
      const a = agent();
      const sc = new SessionChain({ rpcUrl: 'http://127.0.0.1:1', chainId: chain.chainId });
      let sim: { functionName?: string } | undefined;
      const spy = Object.create(chain) as FakeChain;
      spy.estimate = async (r?: unknown) => { sim = (r as { sim?: { functionName?: string } }).sim; return { gas: 100_000n }; };
      sc.attachLane(new SendLane({ pool: db.pool, transport: spy, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000 }));
      const out = await sc.executeTokenTransfer({
        sessionPrivateKey: KEY, accountAddr: ACCOUNT, token: '0x' + 'cd'.repeat(20), to: TO, amountWei: 1234n,
        send: { agentId: a, idemKey: 'via-1', payload: { token: '0x' + 'cd'.repeat(20), to: TO, amount: '1234' } },
      });
      expect(out.txHash).toMatch(/^0x/);
      expect(sim?.functionName).toBe('executeTokenTransfer');
      const [row] = await rows(a);
      expect(row.kind).toBe('token_transfer');
      expect(row.status).toBe('mined');
      expect((await sc.getInFlight(a)).count).toBe(0);
      // same logical send again is a no-op through the production path too
      await sc.executeTokenTransfer({ sessionPrivateKey: KEY, accountAddr: ACCOUNT, token: '0x' + 'cd'.repeat(20), to: TO, amountWei: 1234n, send: { agentId: a, idemKey: 'via-1' } });
      expect(chain.sent).toHaveLength(1);
    });

    it('M-7: the settlement write-ahead (onSubmitted) still fires at broadcast time through the lane', async () => {
      const a = agent();
      const sc = new SessionChain({ rpcUrl: 'http://127.0.0.1:1', chainId: chain.chainId });
      sc.attachLane(new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 60, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000 }));
      const seen: string[] = [];
      const out = await sc.executeTokenTransfer({
        sessionPrivateKey: KEY, accountAddr: ACCOUNT, token: '0x' + 'cd'.repeat(20), to: TO, amountWei: 5n,
        onSubmitted: async (h) => { seen.push(h); },
        send: { agentId: a, idemKey: 'job-fee:1', payload: { amount: '5' } },
      });
      expect(seen).toEqual([out.txHash]);
    });
  });

  describe('Gate-2 round 2', () => {
    const mk = (over: Record<string, unknown> = {}) =>
      new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 40, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, ...over });

    it('N-1: a transport error right after signing is UNKNOWN, not failed: the hash is handed over and the caller gets ReceiptUnconfirmedError', async () => {
      const a = agent();
      chain.sendThrowsBeforeAccept = true;
      const seen: string[] = [];
      const err = await lane.send(req(a, 'n1', { onBroadcast: async (h: string) => { seen.push(h); } })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReceiptUnconfirmedError);
      const row = (await rows(a))[0];
      expect(row.status).toBe('signed');
      expect(seen).toEqual([row.tx_hash]); // the write-ahead handle exists BEFORE any throw
      await mk().reconcile(); // the same bytes go out and land
      expect(['mined', 'finalized']).toContain((await rows(a))[0].status);
      expect(chain.sent).toHaveLength(1);
    });

    it('N-2: a resend refused for a lasting fee reason is counted and escalates to a fee bump (never stuck forever)', async () => {
      const a = agent();
      const bl = mk({ maxRebroadcasts: 1, bumpAfterMs: 0, getSessionKey: async () => KEY });
      chain.autoMine = false;
      await bl.send(req(a, 'n2')).catch(() => undefined);
      const first = (await rows(a))[0];
      chain.drop(first.tx_hash as Hex); // the node forgot it
      const realSend = chain.sendRaw.bind(chain);
      chain.sendRaw = async () => { throw new Error('transaction underpriced'); }; // the market moved: old bytes refused
      await bl.reconcile(); // counted, not rethrown
      expect((await rows(a))[0].rebroadcasts).toBe(1);
      chain.sendRaw = realSend;
      chain.feeNow = 9_000_000_000n;
      await bl.reconcile(); // budget spent -> bump at a market fee
      const row = (await rows(a))[0];
      expect(row.bumps).toBe(1);
      expect(row.tx_hash).not.toBe(first.tx_hash);
      expect(chain.mempool.size).toBe(1);
    });

    it('N-2: a resend refused because the key cannot afford the fee goes straight to a human', async () => {
      const a = agent();
      const seen: string[] = [];
      const bl = mk({ onNeedsReview: (r: { reason: string }) => { seen.push(r.reason); } });
      chain.autoMine = false;
      await bl.send(req(a, 'n2b')).catch(() => undefined);
      chain.drop((await rows(a))[0].tx_hash as Hex);
      chain.sendRaw = async () => { throw new Error('insufficient funds for gas * price + value'); };
      await bl.reconcile();
      expect((await rows(a))[0].status).toBe('needs_review');
      expect(seen[0]).toMatch(/cannot afford/);
    });

    it('N-2: a transport blip during a resend does NOT burn the fee-bump budget', async () => {
      const a = agent();
      const bl = mk({ maxRebroadcasts: 1, bumpAfterMs: 0, getSessionKey: async () => KEY });
      chain.autoMine = false;
      await bl.send(req(a, 'n2c')).catch(() => undefined);
      chain.drop((await rows(a))[0].tx_hash as Hex);
      chain.sendRaw = async () => { throw new Error('HTTP request failed: 504'); };
      await bl.reconcile(); await bl.reconcile(); await bl.reconcile();
      const row = (await rows(a))[0];
      expect(row.rebroadcasts).toBe(0);
      expect(row.bumps).toBe(0);
      expect(row.status).not.toBe('needs_review');
    });

    it('N-3: a needs_review row whose transaction later mines is recognised and UNBLOCKS the key', async () => {
      const a = agent();
      chain.autoMine = false;
      await lane.send(req(a, 'nr1')).catch(() => undefined);
      const h = (await rows(a))[0].tx_hash as Hex;
      chain.drop(h);
      chain.injectExternal(KEY_ADDR, 0n);
      const strict = mk({ receiptGraceMs: 0 });
      await strict.reconcile();
      expect((await rows(a))[0].status).toBe('needs_review');
      // it turns out OUR tx did mine (indexer lag): the receipt appears
      chain.mined.set(h, { status: 'success', blockNumber: 500n, raw: (await rows(a))[0].raw_tx as Hex, from: KEY_ADDR, nonce: 0n });
      await strict.reconcile();
      expect(['mined', 'finalized']).toContain((await rows(a))[0].status);
      chain.autoMine = true;
      await expect(strict.send(req(a, 'nr2'))).resolves.toBeDefined(); // no longer blocked
    });

    it('N-3: after a long outage a signed-but-unsent tx is RETRIED first, and only escalated if the resend fails for good', async () => {
      const a = agent();
      chain.sendThrowsBeforeAccept = true;
      await lane.send(req(a, 'so1')).catch(() => undefined);
      await db.pool.query(`UPDATE tx_intents SET updated_at = now() - interval '30 minutes' WHERE agent_id=$1`, [a]);
      await mk().reconcile(); // the network is back: the bytes are accepted
      expect(['broadcast', 'mined', 'finalized']).toContain((await rows(a))[0].status);
      expect(chain.sent).toHaveLength(1);
    });

    it('M-1/N-3: an owner can clear a blocked key (dismiss), and only then can it send again', async () => {
      const a = agent();
      chain.autoMine = false;
      await lane.send(req(a, 'cl1')).catch(() => undefined);
      chain.drop((await rows(a))[0].tx_hash as Hex);
      chain.injectExternal(KEY_ADDR, 0n);
      const strict = mk({ receiptGraceMs: 0 });
      await strict.reconcile();
      const { getSendBlock } = await import('../../src/runtime/tx-intents/store.js');
      const block = await getSendBlock(db.pool, a);
      expect(block?.reason).toMatch(/nonce consumed/);
      await expect(strict.send(req(a, 'cl2'))).rejects.toBeInstanceOf(TxNeedsReviewError);
      expect(await strict.clearReview(a)).toEqual({ cleared: 1, stillPending: 0 }); // its nonce is spent: safe
      expect(await getSendBlock(db.pool, a)).toBeNull();
      chain.autoMine = true;
      await expect(strict.send(req(a, 'cl2'))).resolves.toBeDefined();
    });

    it('M-9 (strong): two reconcilers that sign DIFFERENT replacement bytes cannot both win the bump', async () => {
      const a = agent();
      // a barrier makes the race DETERMINISTIC: both reconcilers have already read the stuck row before either writes
      let gateOn = false;
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((r) => { release = r; });
      const mkFee = (fee: bigint) => {
        const t = Object.create(chain) as FakeChain;
        t.feeData = async () => {
          if (gateOn) { arrived++; if (arrived >= 2) release(); await bothArrived; }
          return { maxFeePerGas: fee, maxPriorityFeePerGas: fee / 2n };
        };
        return new SendLane({ pool: db.pool, transport: t, confirmTimeoutMs: 30, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, maxRebroadcasts: 0, bumpAfterMs: 0, getSessionKey: async () => KEY });
      };
      chain.autoMine = false;
      await mkFee(2_000_000_000n).send(req(a, 'cas')).catch(() => undefined);
      gateOn = true;
      await Promise.all([mkFee(6_000_000_000n).reconcile(), mkFee(7_000_000_000n).reconcile()]);
      const row = (await rows(a))[0];
      expect(row.bumps).toBe(1); // exactly ONE replacement recorded
      expect(row.prev_hashes).toHaveLength(1);
      for (const h of chain.mempool.keys()) expect(h).toBe(row.tx_hash); // the live tx IS the recorded one
    });
  });

  describe('Gate-2 round 3: clearing a blocked key can never cause a double payment', () => {
    const mk = (over: Record<string, unknown> = {}) =>
      new SendLane({ pool: db.pool, transport: chain, confirmTimeoutMs: 40, pollMs: 5, rebroadcastAfterMs: 0, receiptGraceMs: 60_000, getSessionKey: async () => KEY, ...over });
    /** a payment whose tx is STILL in the mempool but whose intent was escalated to a human (bump budget spent) */
    const blockedButPending = async (a: string, idem: string) => {
      chain.autoMine = false;
      await mk().send(req(a, idem)).catch(() => undefined);
      await db.pool.query(`UPDATE tx_intents SET status='needs_review', error_text='stuck after 3 fee bump(s); not auto-retried' WHERE agent_id=$1`, [a]);
      return (await rows(a))[0];
    };

    it('R3-1: while the original tx can still mine, clear is REFUSED (the owner cannot unlock a second payment)', async () => {
      const a = agent();
      const row = await blockedButPending(a, 'rc1');
      expect(chain.mempool.has(row.tx_hash as Hex)).toBe(true);
      const r = await mk().clearReview(a);
      expect(r).toEqual({ cleared: 0, stillPending: 1 });
      await expect(mk().send(req(a, 'rc1-redecide'))).rejects.toBeInstanceOf(TxNeedsReviewError); // still blocked
      chain.mine(row.tx_hash as Hex); // the original eventually lands
      expect(chain.mined.size).toBe(1); // exactly one payment, ever
    });

    it('R3-1: once the nonce is consumed (the old tx can no longer mine) clearing is safe', async () => {
      const a = agent();
      const row = await blockedButPending(a, 'rc2');
      chain.drop(row.tx_hash as Hex);
      chain.injectExternal(KEY_ADDR, 0n);
      expect((await mk().clearReview(a)).cleared).toBe(1);
      expect((await rows(a))[0].status).toBe('superseded');
    });

    it('R3-1: a tx that is NOT in the mempool and whose nonce is free is safe to clear: the next send reuses that nonce, so at most one can land', async () => {
      const a = agent();
      const row = await blockedButPending(a, 'rc3');
      chain.drop(row.tx_hash as Hex);
      expect((await mk().clearReview(a)).cleared).toBe(1);
      chain.autoMine = true;
      await mk().send(req(a, 'rc3-next'));
      const next = (await rows(a)).find((r) => r.idem_key === 'rc3-next');
      expect(BigInt(next.nonce)).toBe(BigInt(row.nonce)); // SAME nonce
      chain.mempool.set(row.tx_hash as Hex, { from: KEY_ADDR, nonce: BigInt(row.nonce), raw: row.raw_tx as Hex });
      expect(chain.mined.size).toBe(1); // the old one can no longer land: that nonce is spent
    });

    it('R3-1: the owner can CANCEL a waiting tx: it is replaced at the same nonce by a harmless no-op, then the key is free', async () => {
      const a = agent();
      const row = await blockedButPending(a, 'rc4'); // the market fee has NOT moved: the cancel itself must outbid the original
      const r = await mk().cancelBlocked(a);
      expect(r.cancelled).toBe(1);
      expect(chain.mempool.has(row.tx_hash as Hex)).toBe(false); // the original is gone from the mempool
      expect(chain.mempool.size).toBe(1);
      const cancelHash = [...chain.mempool.keys()][0] as Hex;
      chain.mine(cancelHash);
      await mk().reconcile();
      expect(['mined', 'finalized']).toContain((await rows(a))[0].status);
      chain.autoMine = true;
      await expect(mk().send(req(a, 'rc4-next'))).resolves.toBeDefined(); // unblocked
      // only the cancel + the new send ever mined; the ORIGINAL payment never did
      expect(chain.mined.has(row.tx_hash as Hex)).toBe(false);
    });

    it('R3-1: getReviewState says whether clearing is safe or the tx is still waiting', async () => {
      const a = agent();
      await blockedButPending(a, 'rc5');
      const st = await mk().getReviewState(a);
      expect(st).toMatchObject({ pendingOnNetwork: true });
      expect(st?.reason).toMatch(/stuck/);
    });

    it('R3-2: after a fee bump, anything that tracked the ORIGINAL hash (a CCTP rail, a job settlement) follows the replacement', async () => {
      const a = agent();
      const bl = mk({ maxRebroadcasts: 0, bumpAfterMs: 0 });
      chain.autoMine = false;
      await bl.send(req(a, 'rp1')).catch(() => undefined);
      const orig = (await rows(a))[0].tx_hash as string;
      const railId = '00000000-0000-0000-0000-0000000000aa';
      await db.pool.query(
        `INSERT INTO rail_transfers (rail_id, agent_id, account_addr, rail, recovery_mode, src_chain_id, dest_chain_id, asset, amount_wei, status, dest_gas_plan, src_tx)
         VALUES ($1, $2, $3, 'cctp', 'forward_mint', 1, 2, '0xasset', '1', 'initiated', '{"destChainId":2,"fundedWei":"1","source":"ops_fill"}'::jsonb, $4)`,
        [railId, a, ACCOUNT, orig],
      );
      chain.feeNow = 9_000_000_000n;
      await bl.reconcile();
      const bumped = (await rows(a))[0].tx_hash as string;
      expect(bumped).not.toBe(orig);
      expect((await db.pool.query(`SELECT src_tx FROM rail_transfers WHERE rail_id=$1`, [railId])).rows[0].src_tx).toBe(bumped);
    });
  });
});
