import { keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ReceiptUnconfirmedError } from '../../chain/wait-receipt.js';
import { TxInFlightError, TxNeedsReviewError } from './errors.js';
import { classifySendError, isAlreadyKnown, isLastingRejection, isNonceTooLow } from './classify.js';

/**
 * AQ-FND S1 (WP-F) — the SEND LANE: every on-chain write made with an agent's session key goes
 * through here, so that a crash, a null receipt, a lost response or a concurrent sender can never
 * turn into a second payment.
 *
 *   1. idempotency  — one row per (agent, idemKey); the same logical send is never built twice
 *   2. write-ahead  — the SIGNED raw bytes + hash + nonce are persisted BEFORE broadcast
 *   3. one lane     — per (key, chain): an in-process queue AND a database unique index
 *   4. no rebuild   — on any ambiguity we reconcile from (row, chain) and resend the SAME bytes
 *   5. null receipt = unknown, never "failed" (and never permission to pay again)
 *
 * Pure of viem clients on purpose: the chain is behind `LaneTransport`, so the whole state machine
 * is tested against a fault-injecting fake (test/integration/tx-intents.test.ts).
 */
export interface LaneTransport {
  readonly chainId: number;
  getPendingNonce(addr: string): Promise<bigint>;
  getLatestNonce(addr: string): Promise<bigint>;
  /**
   * Simulate the exact tx; throws on revert (a "doomed tx" is never broadcast). When `sim` (the contract
   * call's ABI/function/args) is given the transport simulates WITH it, so a revert comes back as a
   * decodable contract error (a plain estimateGas hides the revert data on geth-style nodes).
   */
  estimate(req: { from: Hex; to: Hex; data: Hex; value: bigint; sim?: ContractSim | undefined }): Promise<{ gas: bigint }>;
  feeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRaw(raw: Hex): Promise<Hex>;
  getReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  getBlockNumber(): Promise<bigint>;
}

/** The contract call behind a tx, so a revert can be decoded into a plain reason. */
export interface ContractSim {
  abi: unknown;
  functionName: string;
  args: unknown[];
}

export type IntentKind = 'transfer' | 'token_transfer' | 'call' | 'sign_arm';

export interface SendRequest {
  agentId: string;
  sessionPrivateKey: string;
  accountAddr: string;
  kind: IntentKind;
  /** Deterministic per logical action (e.g. agent:kind:token:to:amount:cycleId). */
  idemKey: string;
  to: Hex;
  data: Hex;
  value: bigint;
  /** Human + raw facts about the action (amounts as strings) for in-flight accounting and audit. */
  payload: Record<string, unknown>;
  /** Contract call behind `data`, for decodable revert simulation. */
  sim?: ContractSim | undefined;
  /** Fires with the hash the moment the tx is BROADCAST (before the receipt wait): callers with their own write-ahead (job-fee settlement) persist it here. */
  onBroadcast?: ((txHash: string) => Promise<void>) | undefined;
}

export interface SendResult {
  intentId: string;
  txHash: Hex;
  status: 'mined' | 'finalized';
}

export interface SendLaneOpts {
  pool: Pool;
  transport: LaneTransport;
  /** How long `send` waits for the receipt before reporting "ambiguous" (default 90 s). */
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** A broadcast tx older than this with no receipt and an unconsumed nonce is re-broadcast (same bytes). */
  rebroadcastAfterMs?: number;
  /** Nonce consumed but no receipt of ours: wait this long (0G indexing lag) before `needs_review`. */
  receiptGraceMs?: number;
  /** Blocks after which a mined tx is recorded as finalized (chains without reliable tags). */
  finalityDepth?: number;
  /** Re-sends of the SAME bytes before a fee-bumped replacement is signed (default 3). */
  maxRebroadcasts?: number;
  /** Minimum age of an unmined tx before it may be replaced with a higher fee (default 120 s). */
  bumpAfterMs?: number;
  /** Fee-bumped replacements before a human is asked (default 3). */
  maxBumps?: number;
  /** Resolve an agent's session key to re-sign a replacement. Absent => no bump, straight to review. */
  getSessionKey?: (agentId: string) => Promise<string | null>;
  /** Called once when an intent needs a human (nonce consumed by something else / bump budget spent). */
  onNeedsReview?: (info: { intentId: string; agentId: string; chainId: number; keyAddr: string; reason: string }) => void | Promise<void>;
}

interface IntentRow {
  intent_id: string;
  agent_id: string;
  chain_id: number;
  key_addr: string;
  account_addr: string;
  kind: IntentKind;
  idem_key: string;
  payload: Record<string, unknown>;
  status: string;
  nonce: string | null;
  tx_hash: string | null;
  raw_tx: string | null;
  rebroadcasts: number;
  bumps: number;
  prev_hashes: string[];
  gas_limit: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  error_class: string | null;
  error_text: string | null;
  mined_block: string | null;
  created_at: Date;
  updated_at: Date;
  age_ms: number;
}

/** Row + its age measured by the DATABASE clock (the app and DB clocks may differ; never mix them). */
const SEL = '*, (EXTRACT(EPOCH FROM (now() - updated_at)) * 1000)::float8 AS age_ms';
/** An `intent` row older than this (DB clock) never reached `signed`: it holds no signed bytes and is provably not on chain. */
const ORPHAN_INTENT_MS = 120_000;
/** A `signed` row the network never accepted for this long is not resent on stale balances: a human decides. */
const STALE_SIGNED_MS = 15 * 60_000;

export class SendLane {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly confirmTimeoutMs: number;
  private readonly pollMs: number;
  private readonly rebroadcastAfterMs: number;
  private readonly receiptGraceMs: number;
  private readonly finalityDepth: number;
  private readonly maxRebroadcasts: number;
  private readonly bumpAfterMs: number;
  private readonly maxBumps: number;

  constructor(private readonly opts: SendLaneOpts) {
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 1_500;
    this.rebroadcastAfterMs = opts.rebroadcastAfterMs ?? 120_000;
    this.receiptGraceMs = opts.receiptGraceMs ?? 600_000;
    this.finalityDepth = opts.finalityDepth ?? 12;
    this.maxRebroadcasts = opts.maxRebroadcasts ?? 3;
    this.bumpAfterMs = opts.bumpAfterMs ?? 120_000;
    this.maxBumps = opts.maxBumps ?? 3;
  }

  private get pool(): Pool { return this.opts.pool; }
  private get t(): LaneTransport { return this.opts.transport; }

  /** Serialize work per (key, chain) inside this process; the DB index guards across processes. */
  private async withLock<T>(laneKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(laneKey) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined).then(() => { if (this.locks.get(laneKey) === tail) this.locks.delete(laneKey); });
    this.locks.set(laneKey, tail);
    return next;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const account = privateKeyToAccount(req.sessionPrivateKey as Hex);
    const keyAddr = account.address.toLowerCase();
    const laneKey = `${keyAddr}:${this.t.chainId}`;

    // (1) idempotency: a logical send that already has a row is resolved from that row, never re-sent.
    let mine = false; // true once this call has claimed (or reclaimed) the row
    const existing = await this.findByIdem(req.agentId, req.idemKey);
    if (existing) {
      mine = await this.reclaimIfTransient(existing);
      if (!mine) return this.resolveExisting(existing);
    }

    return this.withLock(laneKey, async () => {
      // the same logical send may have been recorded while we waited for the lane
      const again = await this.findByIdem(req.agentId, req.idemKey);
      if (again && !mine) {
        mine = await this.reclaimIfTransient(again);
        if (!mine) return this.resolveExisting(again);
      }

      await this.assertLaneFree(keyAddr);

      const intentId = again?.intent_id ?? randomUUID();
      if (!again) {
        const ins = await this.pool.query(
          `INSERT INTO tx_intents (intent_id, agent_id, chain_id, key_addr, account_addr, kind, idem_key, payload, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'intent') ON CONFLICT (agent_id, idem_key) DO NOTHING RETURNING intent_id`,
          [intentId, req.agentId, this.t.chainId, keyAddr, req.accountAddr.toLowerCase(), req.kind, req.idemKey, JSON.stringify(req.payload)],
        );
        if (ins.rowCount === 0) {
          const raced = await this.findByIdem(req.agentId, req.idemKey);
          if (raced) return this.resolveExisting(raced);
        }
      }

      // EVERYTHING between the INSERT and the `signed` UPDATE is wrapped: any throw there marks the row failed.
      // Otherwise an RPC blip would leave a phantom `intent` that counts as "in flight" forever (review B-1).
      let raw: Hex;
      let txHash: Hex;
      try {
        // (4) simulate the exact tx: a doomed tx is never broadcast
        const { gas } = await this.t.estimate({ from: account.address, to: req.to, data: req.data, value: req.value, sim: req.sim });

        // nonce = max(chain pending count, our own highest live-or-reverted nonce + 1): a lagging RPC can never hand us a used nonce
        const [pending, fees, local] = await Promise.all([
          this.t.getPendingNonce(account.address),
          this.t.feeData(),
          this.pool.query<{ n: string | null }>(
            `SELECT max(nonce) AS n FROM tx_intents WHERE key_addr=$1 AND chain_id=$2 AND status IN ('signed','broadcast','mined','finalized','reverted')`,
            [keyAddr, this.t.chainId],
          ),
        ]);
        const localNext = local.rows[0]?.n != null ? BigInt(local.rows[0].n) + 1n : 0n;
        const nonce = pending > localNext ? pending : localNext;

        const gasLimit = (gas * 12n) / 10n;
        raw = await account.signTransaction({
          chainId: this.t.chainId,
          type: 'eip1559',
          to: req.to,
          data: req.data,
          value: req.value,
          nonce: Number(nonce),
          gas: gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        txHash = keccak256(raw);

        // (2) WRITE-AHEAD: persist the signed bytes before the network ever sees them
        await this.pool.query(
          `UPDATE tx_intents SET status='signed', nonce=$2, raw_tx=$3, tx_hash=$4, gas_limit=$5, max_fee_per_gas=$6,
                  max_priority_fee_per_gas=$7, error_class=NULL, error_text=NULL, updated_at=now() WHERE intent_id=$1`,
          [intentId, nonce.toString(), raw, txHash, gasLimit.toString(), fees.maxFeePerGas.toString(), fees.maxPriorityFeePerGas.toString()],
        );
      } catch (err) {
        const inFlight = (err as { code?: string }).code === '23505';
        await this.fail(intentId, inFlight ? 'transient' : classifySendError(err), err);
        if (inFlight) throw new TxInFlightError(intentId);
        throw err;
      }

      await this.broadcast(intentId, raw, txHash);
      if (req.onBroadcast) await req.onBroadcast(txHash);
      return this.awaitReceipt(intentId, txHash);
    });
  }

  /** Broadcast the signed bytes. Ambiguity (lost response / already known) is reconciled, never rebuilt. */
  private async broadcast(intentId: string, raw: Hex, txHash: Hex): Promise<void> {
    try {
      await this.t.sendRaw(raw);
      await this.setStatus(intentId, 'broadcast');
    } catch (err) {
      if (isAlreadyKnown(err)) {
        await this.setStatus(intentId, 'broadcast');
        return;
      }
      if (isNonceTooLow(err)) {
        // the nonce is consumed: either our tx (lagging receipt) or an outsider. reconcile decides; never rebuild.
        await this.setStatus(intentId, 'broadcast');
        return;
      }
      if (isLastingRejection(err)) {
        // the node REFUSED these bytes for a lasting reason (cannot afford gas*fee, fee below the node minimum):
        // they are in no mempool, so abandoning is safe, and leaving them `signed` would resend a stale action later.
        await this.fail(intentId, 'permanent', err);
        throw err;
      }
      // transport trouble: unknown whether the chain saw it. The row stays `signed`; reconcile re-sends the SAME bytes.
      void txHash;
      throw err;
    }
  }

  private async awaitReceipt(intentId: string, txHash: Hex): Promise<SendResult> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    let attempts = 0;
    for (;;) {
      attempts++;
      let rc: Awaited<ReturnType<LaneTransport['getReceipt']>> = null;
      try { rc = await this.t.getReceipt(txHash); } catch { rc = null; }
      if (rc) return this.recordReceipt(intentId, txHash, rc);
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    // null receipt is UNKNOWN. The row stays `broadcast`; the caller must treat this as in-flight.
    throw new ReceiptUnconfirmedError({ hash: txHash, attempts, quirk: false, cause: new Error('no receipt inside the confirm window') });
  }

  private async recordReceipt(intentId: string, txHash: Hex, rc: { status: 'success' | 'reverted'; blockNumber: bigint }): Promise<SendResult> {
    if (rc.status === 'reverted') {
      await this.pool.query(
        `UPDATE tx_intents SET status='reverted', mined_block=$2, tx_hash=$3, error_class='permanent', error_text='reverted on-chain', updated_at=now() WHERE intent_id=$1 AND status IN ('signed','broadcast')`,
        [intentId, rc.blockNumber.toString(), txHash],
      );
      throw new Error(`execute transfer reverted on-chain: ${txHash}`);
    }
    await this.pool.query(`UPDATE tx_intents SET status='mined', mined_block=$2, tx_hash=$3, updated_at=now() WHERE intent_id=$1 AND status IN ('signed','broadcast')`, [intentId, rc.blockNumber.toString(), txHash]);
    return { intentId, txHash, status: 'mined' };
  }

  private async resolveExisting(row: IntentRow): Promise<SendResult> {
    switch (row.status) {
      case 'mined':
      case 'finalized':
        return { intentId: row.intent_id, txHash: row.tx_hash as Hex, status: row.status };
      case 'needs_review':
        throw new TxNeedsReviewError(row.intent_id);
      case 'reverted':
        throw new Error(`execute transfer reverted on-chain: ${row.tx_hash}`);
      case 'failed':
      case 'dropped':
      case 'superseded':
        throw new Error(row.error_text ?? `this action already failed (${row.status}); it will not be repeated`);
      default: {
        // intent / signed / broadcast: reconcile it, then answer from the result
        await this.reconcileOne(row);
        const fresh = (await this.findByIdem(row.agent_id, row.idem_key)) ?? row;
        if (fresh.status === 'mined' || fresh.status === 'finalized') return { intentId: fresh.intent_id, txHash: fresh.tx_hash as Hex, status: fresh.status };
        if (fresh.status === 'needs_review') throw new TxNeedsReviewError(fresh.intent_id);
        throw new ReceiptUnconfirmedError({ hash: (fresh.tx_hash ?? '0x') as Hex, attempts: 0, quirk: false, cause: new Error('still unconfirmed') });
      }
    }
  }

  /** A send may only start when this key has nothing un-mined and nothing awaiting review. */
  private async assertLaneFree(keyAddr: string): Promise<void> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT ${SEL} FROM tx_intents WHERE key_addr=$1 AND chain_id=$2 AND status IN ('signed','broadcast','needs_review') ORDER BY created_at`,
      [keyAddr, this.t.chainId],
    );
    for (const r of rows) {
      if (r.status === 'needs_review') throw new TxNeedsReviewError(r.intent_id);
      await this.reconcileOne(r); // it may have mined meanwhile
    }
    const left = await this.pool.query<{ intent_id: string; status: string }>(
      `SELECT intent_id, status FROM tx_intents WHERE key_addr=$1 AND chain_id=$2 AND status IN ('signed','broadcast','needs_review') LIMIT 1`,
      [keyAddr, this.t.chainId],
    );
    const l = left.rows[0];
    if (l?.status === 'needs_review') throw new TxNeedsReviewError(l.intent_id);
    if (l) throw new TxInFlightError(l.intent_id);
  }

  /** Boot + periodic: resolve every open intent from (row, chain). Never rebuilds a tx. */
  async reconcile(): Promise<{ examined: number }> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT ${SEL} FROM tx_intents WHERE chain_id=$1 AND status IN ('intent','signed','broadcast','mined') ORDER BY created_at`,
      [this.t.chainId],
    );
    for (const r of rows) {
      try { await this.reconcileOne(r); } catch (err) { console.warn('[tx-intents] reconcile failed for', r.intent_id, err instanceof Error ? err.message : err); }
    }
    return { examined: rows.length };
  }

  private async reconcileOne(row: IntentRow): Promise<void> {
    if (row.status === 'intent') {
      // never reached `signed`: no bytes exist, so it is provably not on chain. Abandon the orphan.
      if (row.age_ms >= ORPHAN_INTENT_MS) {
        await this.pool.query(
          `UPDATE tx_intents SET status='failed', error_class='transient', error_text='abandoned before it was signed (the process stopped mid-send)', updated_at=now() WHERE intent_id=$1 AND status='intent'`,
          [row.intent_id],
        );
      }
      return;
    }
    if (row.status === 'mined') {
      if (row.mined_block != null && (await this.t.getBlockNumber()) - BigInt(row.mined_block) >= BigInt(this.finalityDepth)) {
        await this.pool.query(`UPDATE tx_intents SET status='finalized', finalized_at=now(), updated_at=now() WHERE intent_id=$1 AND status='mined'`, [row.intent_id]);
      }
      return;
    }
    if (row.status !== 'signed' && row.status !== 'broadcast') return;
    const hash = row.tx_hash as Hex | null;
    const nonce = row.nonce != null ? BigInt(row.nonce) : null;
    if (!hash || nonce === null || !row.raw_tx) return;

    // a replacement race: ANY hash we ever signed for this nonce may be the one that mines
    for (const h of [hash, ...(row.prev_hashes ?? []) as Hex[]]) {
      const found = await this.t.getReceipt(h).catch(() => null);
      if (found) { await this.recordReceipt(row.intent_id, h, found).catch(() => undefined); return; }
    }

    const latest = await this.t.getLatestNonce(row.key_addr);
    if (latest > nonce) {
      // the nonce is used but we hold no receipt for our hash: lagging index OR an outsider took it.
      const age = row.age_ms;
      if (age >= this.receiptGraceMs) {
        await this.toReview(row, 'nonce consumed without a receipt for our tx');
      }
      return;
    }

    // nonce not consumed: our tx is not mined. Re-send the SAME bytes (never a rebuilt tx).
    const age = row.age_ms;
    // signed, never accepted by any node, for too long: do NOT resend an action decided on old balances; ask a human.
    if (row.status === 'signed' && row.rebroadcasts === 0 && age >= STALE_SIGNED_MS) {
      await this.toReview(row, 'signed but never accepted by the network; not resent because it was decided on old balances');
      return;
    }
    if (row.status === 'signed' || age >= this.rebroadcastAfterMs) {
      // rebroadcast budget spent and still not mined: replace at the SAME nonce with a higher fee (or ask a human)
      if (row.status === 'broadcast' && row.rebroadcasts >= this.maxRebroadcasts && age >= this.bumpAfterMs) {
        await this.bumpOrReview(row);
        return;
      }
      try {
        await this.t.sendRaw(row.raw_tx as Hex);
      } catch (err) {
        if (!isAlreadyKnown(err) && !isNonceTooLow(err)) throw err;
      }
      await this.pool.query(
        `UPDATE tx_intents SET status='broadcast', rebroadcasts = rebroadcasts + 1, updated_at=now() WHERE intent_id=$1 AND status IN ('signed','broadcast')`,
        [row.intent_id],
      );
      // give a just-re-sent tx one chance to show a receipt
      const rc2 = await this.t.getReceipt(hash).catch(() => null);
      if (rc2) await this.recordReceipt(row.intent_id, hash, rc2).catch(() => undefined);
    }
  }

  /** Hand an intent to a human: persist the state, then notify once. */
  private async toReview(row: IntentRow, reason: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE tx_intents SET status='needs_review', error_class='ambiguous', error_text=$2, updated_at=now() WHERE intent_id=$1 AND status IN ('signed','broadcast')`,
      [row.intent_id, reason],
    );
    if ((res.rowCount ?? 0) > 0 && this.opts.onNeedsReview) {
      try { await this.opts.onNeedsReview({ intentId: row.intent_id, agentId: row.agent_id, chainId: row.chain_id, keyAddr: row.key_addr, reason }); } catch { /* notification is best-effort */ }
    }
  }

  /**
   * An un-mined tx that has been re-sent enough: replace it at the SAME nonce with a >= 12.5% higher fee
   * (a node refuses less). Keeps every previous hash so a late mining of ANY of them is still recognised.
   * Never a new nonce; never a different payload. Beyond `maxBumps`, or without a key, a human decides.
   */
  private async bumpOrReview(row: IntentRow): Promise<void> {
    if (row.bumps >= this.maxBumps) return this.toReview(row, `stuck after ${row.bumps} fee bump(s); not auto-retried`);
    const key = this.opts.getSessionKey ? await this.opts.getSessionKey(row.agent_id).catch(() => null) : null;
    if (!key || !row.raw_tx || !row.max_fee_per_gas || !row.max_priority_fee_per_gas || !row.gas_limit) {
      return this.toReview(row, 'unmined and cannot be replaced automatically');
    }
    const parsed = parseTransaction(row.raw_tx as Hex);
    const nowFees = await this.t.feeData();
    const bump = (v: bigint): bigint => (v * 1125n) / 1000n + 1n;
    let maxFee = bump(BigInt(row.max_fee_per_gas));
    let tip = bump(BigInt(row.max_priority_fee_per_gas));
    if (nowFees.maxFeePerGas > maxFee) maxFee = nowFees.maxFeePerGas;
    if (nowFees.maxPriorityFeePerGas > tip) tip = nowFees.maxPriorityFeePerGas;
    if (tip > maxFee) tip = maxFee;
    const account = privateKeyToAccount(key as Hex);
    if (account.address.toLowerCase() !== row.key_addr) return this.toReview(row, 'the session key no longer matches the transaction signer');
    const raw = await account.signTransaction({
      chainId: this.t.chainId,
      type: 'eip1559',
      to: parsed.to as Hex,
      data: (parsed.data ?? '0x'),
      value: parsed.value ?? 0n,
      nonce: Number(row.nonce),
      gas: BigInt(row.gas_limit),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
    });
    const newHash = keccak256(raw);
    // write-ahead again: persist the replacement (and remember the old hash) BEFORE broadcasting it
    // compare-and-swap on the hash we read: if another reconciler already replaced it, this one stands down (no lost hash)
    const won = await this.pool.query(
      `UPDATE tx_intents SET raw_tx=$2, tx_hash=$3, prev_hashes = array_append(prev_hashes, $4), bumps = bumps + 1, rebroadcasts = 0,
              max_fee_per_gas=$5, max_priority_fee_per_gas=$6, status='broadcast', updated_at=now()
        WHERE intent_id=$1 AND status IN ('signed','broadcast') AND tx_hash=$4 AND bumps=$7`,
      [row.intent_id, raw, newHash, row.tx_hash, maxFee.toString(), tip.toString(), row.bumps],
    );
    if ((won.rowCount ?? 0) === 0) return;
    try {
      await this.t.sendRaw(raw);
    } catch (err) {
      if (!isAlreadyKnown(err) && !isNonceTooLow(err)) console.warn('[tx-intents] bump broadcast failed (will retry from the stored bytes):', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Un-mined work for an agent, for in-flight accounting. Counts `signed`/`broadcast` and an `intent` that is
   * still young (its send is probably mid-flight in this process); an old orphan `intent` is NOT in flight.
   * `needsReview` is true when a human must clear a blocked key before this agent can send again.
   */
  async getInFlight(agentId: string, token?: string): Promise<{ count: number; amountWei: bigint; needsReview: boolean }> {
    const { rows } = await this.pool.query<{ payload: Record<string, unknown>; status: string }>(
      `SELECT payload, status FROM tx_intents WHERE agent_id=$1 AND chain_id=$2
         AND (status IN ('signed','broadcast','needs_review') OR (status='intent' AND updated_at > now() - make_interval(secs => $3)))`,
      [agentId, this.t.chainId, ORPHAN_INTENT_MS / 1000],
    );
    let amount = 0n;
    let count = 0;
    let needsReview = false;
    for (const r of rows) {
      if (r.status === 'needs_review') { needsReview = true; continue; }
      const tok = r.payload['token'];
      if (token && (typeof tok !== 'string' || tok.toLowerCase() !== token.toLowerCase())) continue;
      count++;
      const a = r.payload['amount'];
      if (typeof a === 'string' && /^\d+$/.test(a)) amount += BigInt(a);
    }
    return { count, amountWei: amount, needsReview };
  }

  /**
   * A transient failure (an RPC blip before anything was signed) must not poison the idempotency key:
   * the same logical action is allowed to try again. A failed row that was ever SIGNED is never reclaimed here.
   */
  private async reclaimIfTransient(row: IntentRow): Promise<boolean> {
    if (row.status !== 'failed' || row.error_class !== 'transient' || row.raw_tx) return false;
    const r = await this.pool.query(
      `UPDATE tx_intents SET status='intent', error_class=NULL, error_text=NULL, updated_at=now() WHERE intent_id=$1 AND status='failed' AND raw_tx IS NULL`,
      [row.intent_id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  private async findByIdem(agentId: string, idemKey: string): Promise<IntentRow | null> {
    const { rows } = await this.pool.query<IntentRow>(`SELECT ${SEL} FROM tx_intents WHERE agent_id=$1 AND idem_key=$2`, [agentId, idemKey]);
    return rows[0] ?? null;
  }

  private async setStatus(intentId: string, status: string): Promise<void> {
    await this.pool.query(`UPDATE tx_intents SET status=$2, updated_at=now() WHERE intent_id=$1 AND status IN ('intent','signed','broadcast')`, [intentId, status]);
  }

  private async fail(intentId: string, cls: string, err: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE tx_intents SET status='failed', error_class=$2, error_text=$3, updated_at=now() WHERE intent_id=$1`,
      [intentId, cls, (err instanceof Error ? err.message : String(err)).slice(0, 500)],
    );
  }
}
