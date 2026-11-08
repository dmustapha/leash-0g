import { randomUUID } from 'node:crypto';
/**
 * AQ-FND M-3 inc-3a — the swap-to-gas EXECUTOR (token -> native on a Uniswap V3 chain).
 *
 * `planGasRoute` (pure, unchanged) says `swap-to-gas`; this module is what makes the agent
 * actually buy its own gas THROUGH THE GOVERNED WALL, with the SESSION key:
 *
 *   1. approve(router, amountIn)       exact amount, spender = the chain's SwapRouter02 only
 *   2. router.exactInputSingle(...)    token -> WETH9, recipient = the ACCOUNT (self)
 *   3. WETH9.withdraw(wethBalance)     unwrap to NATIVE in the account
 *   4. account.execute(sessionKey, dust)  the existing rung-2 refuel
 *
 * `precheckGasSwap` runs every swap-side call through the EXISTING `classifyIntendedCall` BEFORE
 * anything is submitted (P3C-6: never a doomed submit); `executeGasSwap` submits the legs in
 * order, each awaited to a successful receipt (`executeCall` throws on revert). Nothing here
 * invents an escalation path: anything the owner's grants do not cover is returned to the caller,
 * which raises the EXISTING capability request (L2) or the ONE `gas_request` ask (forbidden).
 *
 * OWNER GRANTS REQUIRED (the `gas_swap` preset covers the call rules + budget):
 *   - call rule (router, exactInputSingle 0x04e45aaf), recipientMode self
 *   - call rule (WETH9, withdraw 0x2e1a7d4d)
 *   - call rule (token, approve) with spenderSet = [router] and perCallCap >= gasSwap.tokenAmount
 *   - a token budget on the sold token (windowCap)
 *   - the session key as an allowlisted NATIVE payee (the refuel; NOT a call rule)
 *   - router + WETH9 inside the chain's protocolAllowlist when one is configured
 */
import type { Address } from 'viem';
import type { Pool } from 'pg';
import type { ChainConfig } from '../chain/registry.js';
import { classifyIntendedCall, type GateResult } from '../gateway/call-gate.js';
import {
  buildGasSwapCalls,
  buildWrappedNativeUnwrap,
  type GasSwapCall,
  type GrantState,
} from '../governed-call/index.js';
import { loadGrantState } from './grant-state.js';
import type { RuntimeChain } from './session-chain.js';

const ZERO = '0x0000000000000000000000000000000000000000';

type GasSwapConfig = NonNullable<ChainConfig['gasSwap']>;

/** The static inputs both phases need (all server-side: config + the agent's own identity). */
export interface GasSwapEnv {
  pool: Pool;
  chain: RuntimeChain;
  agentId: string;
  accountAddr: string;
  chainConfig: ChainConfig;
  /** the chain's bridge allowlist, so classify's bridge arm sees the same state as decideCall */
  bridgeTargets?: Set<string> | undefined;
}

export type GasSwapPrecheck =
  | { ok: true; amountIn: bigint }
  /** a leg is outside the standing grants (novel): raise the capability request for THIS leg */
  | { ok: false; kind: 'l2'; leg: GasSwapCall['leg']; gate: GateResult }
  /** a leg can never run (forbidden): one gas ask naming the blocked step */
  | { ok: false; kind: 'forbidden'; leg: GasSwapCall['leg']; reason: string }
  /** the chain has no executor config / nothing to sell */
  | { ok: false; kind: 'unavailable'; reason: string };

/** A leg of the route failed; `cause` is the underlying chain error (decodable by the caller). */
export class GasSwapLegError extends Error {
  constructor(
    readonly leg: GasSwapCall['leg'] | 'refuel',
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'GasSwapLegError';
  }
}

/** The executor's static config, or null when the chain has no router / gas-swap constants. */
export function gasSwapSetup(chainConfig: ChainConfig): { router: Address; gs: GasSwapConfig } | null {
  const router = chainConfig.canonical?.router;
  const gs = chainConfig.gasSwap;
  if (!router || !gs) return null;
  return { router: router.toLowerCase() as Address, gs };
}

async function readGrantState(env: GasSwapEnv, gs: GasSwapConfig): Promise<GrantState> {
  const grant = await loadGrantState(env.pool, env.chain, env.agentId, env.accountAddr, env.bridgeTargets);
  // The swap may only BUY the chain's wrapped-native (classify pins the decoded tokenOut).
  grant.swapOutputTokens = new Set([gs.wrappedNative.toLowerCase()]);
  return grant;
}

/** amountIn = min(spendable token balance, the per-chain config figure). Never model-derived. */
async function swapAmountIn(env: GasSwapEnv, token: Address, gs: GasSwapConfig): Promise<bigint> {
  const balance = await env.chain.getErc20Balance(token, env.accountAddr);
  return balance < gs.tokenAmount ? balance : gs.tokenAmount;
}

/**
 * Build the swap-side legs and classify each against the owner's live grants (in leg order, so the
 * FIRST uncovered leg is the one reported). The unwrap amount is only known after the swap, so it
 * is probed with 1 wei here (rule existence / L1-ness) and re-classified with the real amount
 * right before it is submitted.
 */
export async function precheckGasSwap(env: GasSwapEnv, token: Address, sessionKeyAddr: string): Promise<GasSwapPrecheck> {
  const setup = gasSwapSetup(env.chainConfig);
  if (!setup) return { ok: false, kind: 'unavailable', reason: 'chain has no gas-swap config' };
  const amountIn = await swapAmountIn(env, token, setup.gs);
  if (amountIn <= 0n) return { ok: false, kind: 'unavailable', reason: 'nothing to sell: token balance is zero' };

  // The final refuel leg pays the session key natively: it must be an allowlisted native payee,
  // or the swap would land native in the account that the key can never draw (fail before leg 1).
  const nativePolicy = await env.chain.getAssetPolicy?.(env.accountAddr, ZERO, [sessionKeyAddr]);
  if (!nativePolicy?.allowedPayees.includes(sessionKeyAddr.toLowerCase())) {
    return { ok: false, kind: 'unavailable', reason: 'the session key is not an allowlisted native payee (refuel leg)' };
  }

  const self = env.accountAddr.toLowerCase() as Address;
  const wrapped = setup.gs.wrappedNative.toLowerCase() as Address;
  const { approve, swap } = buildGasSwapCalls({
    self,
    token,
    router: setup.router,
    wrappedNative: wrapped,
    feeTier: setup.gs.dexFeeTier,
    amountIn,
  });
  const grant = await readGrantState(env, setup.gs);
  for (const call of [approve, swap, buildWrappedNativeUnwrap(wrapped, 1n)]) {
    const gate = classifyIntendedCall(call.target, call.value, call.data, grant, self);
    const lane = gate.classification;
    if (lane.lane === 'l2') return { ok: false, kind: 'l2', leg: call.leg, gate };
    if (lane.lane === 'forbidden') return { ok: false, kind: 'forbidden', leg: call.leg, reason: lane.reason };
  }
  return { ok: true, amountIn };
}

export interface GasSwapExecInput {
  sessionPrivateKey: string;
  sessionKeyAddr: string;
  token: Address;
  amountIn: bigint;
  /** chain-priced session-key dust for the final refuel leg (config) */
  refuelWei: bigint;
  /** AQ-FND S1: the cycle that runs this swap — scopes the idempotency key of every leg. */
  cycleId?: string | undefined;
}

/**
 * Run the four legs in order with the SESSION key. A leg's failure throws `GasSwapLegError`
 * and no later leg runs (no retry loop - the next cycle re-plans from chain state). Returns
 * every tx hash in leg order.
 */
export async function executeGasSwap(env: GasSwapEnv, input: GasSwapExecInput): Promise<string[]> {
  const setup = gasSwapSetup(env.chainConfig);
  if (!setup) throw new GasSwapLegError('approve', new Error('chain has no gas-swap config'));
  const self = env.accountAddr.toLowerCase() as Address;
  const wrapped = setup.gs.wrappedNative.toLowerCase() as Address;
  const hashes: string[] = [];
  const submit = async (leg: GasSwapCall['leg'] | 'refuel', target: string, value: bigint, data: string): Promise<void> => {
    try {
      const { txHash } = await env.chain.executeCall({
        sessionPrivateKey: input.sessionPrivateKey,
        accountAddr: env.accountAddr,
        target,
        valueWei: value,
        data,
        send: { agentId: env.agentId, idemKey: `${env.agentId}:gasswap:${leg}:${input.cycleId ?? randomUUID()}`, payload: { leg, target, value: value.toString() } },
      });
      hashes.push(txHash);
    } catch (err) {
      throw new GasSwapLegError(leg, err);
    }
  };

  const { approve, swap } = buildGasSwapCalls({
    self,
    token: input.token,
    router: setup.router,
    wrappedNative: wrapped,
    feeTier: setup.gs.dexFeeTier,
    amountIn: input.amountIn,
  });
  await submit('approve', approve.target, approve.value, approve.data);
  await submit('swap', swap.target, swap.value, swap.data);

  // The WETH the swap produced (server read of the account's WETH balance, not model text).
  const wethOut = await env.chain.getErc20Balance(wrapped, env.accountAddr);
  if (wethOut <= 0n) throw new GasSwapLegError('swap', new Error('swap landed but the account holds no wrapped native'));
  const unwrap = buildWrappedNativeUnwrap(wrapped, wethOut);
  const grant = await readGrantState(env, setup.gs);
  const gate = classifyIntendedCall(unwrap.target, unwrap.value, unwrap.data, grant, self);
  if (gate.classification.lane !== 'l1') {
    throw new GasSwapLegError('unwrap', new Error(`unwrap of ${wethOut} is outside the owner's grants (${gate.classification.lane})`));
  }
  await submit('unwrap', unwrap.target, unwrap.value, unwrap.data);

  // Refuel with what the swap actually bought, capped at the chain-priced dust: a thin swap
  // must refuel less, not revert for want of balance after the tokens are already sold.
  const accountNative = await env.chain.getBalance(env.accountAddr);
  const refuelWei = accountNative < input.refuelWei ? accountNative : input.refuelWei;
  if (refuelWei <= 0n) throw new GasSwapLegError('refuel', new Error('the account holds no native after the unwrap'));
  // The session key calls account.execute(sessionKey, wei) DIRECTLY (executeTransfer). Routing it
  // through executeCall with the account as its own target is refused on-chain (SelfCallForbidden).
  try {
    const { txHash } = await env.chain.executeTransfer({
      sessionPrivateKey: input.sessionPrivateKey,
      accountAddr: env.accountAddr,
      to: input.sessionKeyAddr,
      valueWei: refuelWei,
      send: { agentId: env.agentId, idemKey: `${env.agentId}:gasswap:refuel:${input.cycleId ?? randomUUID()}`, payload: { leg: 'refuel', to: input.sessionKeyAddr, amount: refuelWei.toString(), native: true } },
    });
    hashes.push(txHash);
  } catch (err) {
    throw new GasSwapLegError('refuel', err);
  }
  return hashes;
}
