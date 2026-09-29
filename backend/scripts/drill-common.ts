// SE-4 shared TS drill library — bounded RPC-flake tolerance + baseline-reset helpers for the
// viem-based deployed drills (create-v4, one-shot-consume), mirroring contracts/script/
// drill-common.sh. viem's fee estimation already satisfies 0G's gas-price floor (unlike raw
// `cast`), so this focuses on the two SE-4 disciplines: (1) a transient 0G RPC failure
// (timeout, receipt drop, empty response) is retried a bounded number of times, never recorded
// as a logic pass/fail; (2) a genuine revert is classified, never masked as a flake.
//
// One deployed-stack config drives the drills (STACK), so SE-5's per-chain registry can point
// them at another chain without forking the drill bodies.
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { zeroGChain } from '../src/chain/ops.js';

export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes('=')) {
      const i = t.indexOf('=');
      env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, '');
    }
  }
  return env;
}

/** The deployed-stack config object — SE-5 swaps this per chain. */
export interface DrillStack {
  name: string;
  chainId: number;
  rpc: string;
  opsPrivateKey: Hex;
  account: Hex;      // DrillAccount (owner == sessionKey == ops)
  usd: Hex;
  router: Hex;
  vault: Hex;
  attacker: Hex;
  basePerCallCap: bigint;
  baseWindowCap: bigint;
}

export const APPROVE_SEL = '0x095ea7b3' as Hex;
export const DEPOSIT_SEL = '0x6e553f65' as Hex;

export function stack0g16602(env = loadEnv()): DrillStack {
  const opsPk = env.OPS_PRIVATE_KEY;
  const rpc = env.ZERO_G_RPC;
  if (!opsPk) throw new Error('missing OPS_PRIVATE_KEY in backend/.env');
  if (!rpc) throw new Error('missing ZERO_G_RPC in backend/.env');
  const pk = opsPk.startsWith('0x') ? opsPk : `0x${opsPk}`;
  return {
    name: '0g-16602',
    chainId: Number(env.ZERO_G_CHAIN_ID ?? '16602'),
    rpc,
    opsPrivateKey: pk as Hex,
    account: getAddress('0x2FDbfa0e76D4dC455C95C4e7d445595E714cDCDF'),
    usd: getAddress('0x4E51f90C8Cf60307E01A6abF555762e69Ef0eC2A'),
    router: getAddress('0x425B8638e1B851486F397715EA414d52A1Ab7a65'),
    vault: getAddress('0x6F370dd513bF45D69178cb2E1BEe2BF15bAFCE87'),
    attacker: getAddress('0x000000000000000000000000000000000000dEaD'),
    basePerCallCap: 200_000_000n,
    baseWindowCap: 1_000_000_000_000n,
  };
}

export interface DrillClients {
  account: PrivateKeyAccount;
  pub: PublicClient;
  wallet: WalletClient;
}
export function makeClients(s: DrillStack): DrillClients {
  const account = privateKeyToAccount(s.opsPrivateKey);
  const chain = zeroGChain(s.rpc, s.chainId);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(s.rpc) }),
    wallet: createWalletClient({ chain, transport: http(s.rpc), account }),
  };
}

/** A transient RPC failure — retryable. Deliberately excludes reverts (execution reverted /
 *  a 4-byte custom-error selector), so a genuine revert is never swallowed as a flake. */
export function isFlake(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // A decoded revert is NEVER a flake (checked first, so a genuine wall failure is never swallowed).
  if (/execution reverted|reverted with|reverted on-chain|custom error|0x[0-9a-f]{8}/.test(m)) return false;
  // Only transport-layer phrasings retry. Note: viem's waitForTransactionReceipt does its own
  // receipt polling, so "receipt not found" is intentionally NOT here — that avoids re-submitting
  // (fresh-nonce) a tx whose receipt merely dropped, which could double-send an owner setup tx.
  // Includes 0G's receipt-fetch transients: a mined tx's receipt can momentarily 404 as
  // "no matching receipts found: this may indicate potential data corruption" (surfaced by viem
  // as InvalidInputRpcError). These are transient on 0G and resolve on a re-poll of the same hash.
  return /timeout|timed out|network error|connection refused|connection reset|econnreset|reset by peer|socket hang up|fetch failed|deadline|429|502|503|504|empty response|temporarily unavailable|no matching receipts|data corruption/.test(
    m,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a fn a bounded number of times ONLY on a transient flake; a genuine error rethrows. */
export async function withFlakeRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; sleepMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  const sleepMs = opts.sleepMs ?? 4000;
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isFlake(err)) throw err;
      if (i < retries - 1) await sleep(sleepMs);
    }
  }
  throw new Error(`flake budget exhausted${opts.label ? ` (${opts.label})` : ''}: ${String(last)}`);
}

/**
 * Confirm a tx by RE-POLLING THE SAME HASH — this is the SE-4-safe way to tolerate 0G's
 * dominant transient (a dropped/late receipt) with ZERO double-submit risk (M-01): we never
 * resend, we just keep asking for the same hash's receipt. A "receipt not found" is transient
 * here (retry); a mined receipt with a non-success status is a genuine on-chain revert (throw).
 * Any viem receiver type works (PublicClient or a test client) — hence the structural param.
 */
export async function confirmReceipt(
  pub: { getTransactionReceipt: (a: { hash: Hex }) => Promise<{ status: string }> },
  hash: Hex,
  opts: { retries?: number; sleepMs?: number } = {},
): Promise<void> {
  const retries = opts.retries ?? 24;
  const sleepMs = opts.sleepMs ?? 5000;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`tx ${hash} reverted on-chain (status=${r.status})`);
      return;
    } catch (err) {
      const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (m.includes('reverted on-chain')) throw err; // genuine revert — never retried
      // getTransactionReceipt only fails for (a) receipt-not-yet-available or (b) an RPC transport
      // hiccup ("no matching receipts found", "data corruption", 5xx) — BOTH transient on 0G and
      // resolved by re-polling the SAME hash (never a resend, so no double-submit). Anything that
      // is NOT our own "reverted on-chain" throw is therefore retryable here.
      if (i < retries - 1) await sleep(sleepMs);
    }
  }
  throw new Error(`receipt for ${hash} never confirmed within budget (flake-exhausted)`);
}

/** Flake-tolerant governed/owner tx: submit ONCE, then confirm by re-polling the same hash.
 *  A client-side revert (bad calldata, over cap) rethrows from the submit; a dropped receipt is
 *  tolerated by confirmReceipt WITHOUT resending (no double-submit). */
export async function sendTx(
  c: DrillClients,
  to: Hex,
  data: Hex,
  opts: { gas?: bigint } = {},
): Promise<Hex> {
  const hash = await c.wallet.sendTransaction({
    chain: c.wallet.chain,
    account: c.account,
    to,
    data,
    ...(opts.gas ? { gas: opts.gas } : {}),
  });
  await confirmReceipt(c.pub, hash);
  return hash;
}

export type RevertOutcome =
  | { kind: 'reverted'; detail: string }
  | { kind: 'succeeded'; detail: string }
  | { kind: 'flake'; detail: string };

/** eth_call expected to REVERT with `wantSelector`. Retries only on a transient flake; a
 *  success or a wrong-selector revert is a genuine (non-flake) outcome. */
export async function expectRevert(
  c: DrillClients,
  from: Hex,
  to: Hex,
  data: Hex,
  wantSelector: RegExp,
  opts: { retries?: number; sleepMs?: number } = {},
): Promise<RevertOutcome> {
  const retries = opts.retries ?? 8;
  const sleepMs = opts.sleepMs ?? 4000;
  for (let i = 0; i < retries; i++) {
    try {
      await c.pub.call({ account: from, to, data });
      return { kind: 'succeeded', detail: 'call unexpectedly succeeded' };
    } catch (err) {
      const msg = String((err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message);
      if (wantSelector.test(msg)) return { kind: 'reverted', detail: msg.slice(0, 160) };
      if (!isFlake(err)) return { kind: 'succeeded', detail: `reverted with wrong error: ${msg.slice(0, 160)}` };
      if (i < retries - 1) await sleep(sleepMs);
    }
  }
  return { kind: 'flake', detail: 'RPC flake budget exhausted (inconclusive)' };
}
