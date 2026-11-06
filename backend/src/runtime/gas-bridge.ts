/**
 * AQ-FND M-3 inc-3b S3 — the bridge-then-swap SOURCE leg (CCTP v2 USDC burn), through the governed wall.
 *
 * `planGasRoute` says `bridge-then-swap` (the agent holds a settlement token on chain A, has native
 * there for the burn, and chain B — where it needs gas — has a DEX). This module runs ONLY the source
 * half, with the SESSION key on chain A:
 *
 *   1. approve(tokenMessenger, amount)           exact amount, spender = the chain's CCTP TokenMessenger
 *   2. tokenMessenger.depositForBurn(...)        recipient = the SAME-ADDRESS account on chain B
 *
 * It opens the durable `rail_transfers` row BEFORE the first broadcast (so a crash mid-sequence leaves a
 * handle on the funds), write-aheads the burn hash, and returns. Everything after — Circle's attestation,
 * the permissionless `receiveMessage` on chain B (submitted by the ops key, which pays that gas: the
 * ruled "ops_fill" plan), and recovery — belongs to the RailDriver + sweep (S2). Once the mint lands the
 * USDC sits in the account on chain B and the NEXT cycle's plan finds `swap-to-gas` there (inc-3a): the
 * "then swap" needs no new code. While a transfer is open the planner must not start a second bridge
 * (`hasOpenBridgeInto`).
 *
 * Every call is built server-side (`buildCctpBurnCalls`) and re-classified against the owner's LIVE
 * grants on the source chain before anything is submitted (never a doomed submit); the bridge-gate
 * (allowlist + decoded domain + same-address CREATE2 proof) is a hard precondition, injected as
 * `assertRoutable` and fail-closed. Anything the grants do not cover is returned to the caller, which
 * raises the existing capability request / the one gas ask. No relayer is involved.
 *
 * OWNER GRANTS REQUIRED on the SOURCE chain (the `gas_bridge` preset): approve(USDC) with spenderSet =
 * [TokenMessenger]; depositForBurn on the TokenMessenger; a token budget on USDC; the TokenMessenger in the
 * chain's bridge allowlist (config).
 */
import type { Address } from 'viem';
import type { Pool } from 'pg';
import type { ChainConfig } from '../chain/registry.js';
import { classifyIntendedCall, type GateResult } from '../gateway/call-gate.js';
import { buildCctpBurnCalls, type BridgeCall, type DecodedCall } from '../governed-call/index.js';
import { cctpDomainOfChain } from '../governed-call/rail-domains.js';
import {
  initiateRailTransfer,
  listRailTransfersForAgent,
  markFailed,
  recordSourceSubmitted,
  OPEN_RAIL_STATUSES,
} from '../store/rail-transfers.js';
import { loadGrantState } from './grant-state.js';
import type { RuntimeChain } from './session-chain.js';

/** What both phases need (all server-side: config + the agent's own identity). */
export interface GasBridgeEnv {
  pool: Pool;
  /** the SOURCE chain's session chain (where the USDC sits and the burn happens) */
  srcChain: RuntimeChain;
  srcChainConfig: ChainConfig;
  agentId: string;
  accountAddr: string;
  /** the chain where the agent needs gas (the swap happens there after the mint) */
  destChainId: number;
  /** cap on one bridge: the destination's `gasSwap.tokenAmount` (just enough to buy gas there) */
  amountCap: bigint;
  /** gas the ops key is expected to spend on the destination fill (recorded as the `ops_fill` plan) */
  fillGasWei: bigint;
  /** the bridge-gate (assertBridgeRoutable bound to this agent) — REQUIRED, fail-closed */
  assertRoutable: (
    bridgeTarget: string,
    decoded?: DecodedCall,
  ) => Promise<{ destinationChainId: number; verifiedAddr: string }>;
}

export type GasBridgePrecheck =
  | { ok: true; amount: bigint; messenger: Address; domain: number }
  | { ok: false; kind: 'l2'; leg: BridgeCall['leg']; gate: GateResult }
  | { ok: false; kind: 'forbidden'; leg: BridgeCall['leg']; reason: string }
  | { ok: false; kind: 'unavailable'; reason: string };

export class GasBridgeLegError extends Error {
  constructor(
    readonly leg: BridgeCall['leg'],
    override readonly cause: unknown,
    readonly railId: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'GasBridgeLegError';
  }
}

/** True while this agent already has a transfer into `destChainId` that is not terminal. */
export async function hasOpenBridgeInto(pool: Pool, agentId: string, destChainId: number): Promise<boolean> {
  const rows = await listRailTransfersForAgent(pool, agentId, 20);
  return rows.some((r) => r.destChainId === destChainId && (OPEN_RAIL_STATUSES as readonly string[]).includes(r.status));
}

function setup(env: GasBridgeEnv): { messenger: Address; domain: number } | null {
  const messenger = env.srcChainConfig.cctpTokenMessenger;
  const domain = cctpDomainOfChain(env.destChainId);
  if (!messenger || domain === null) return null;
  return { messenger: messenger.toLowerCase() as Address, domain };
}

async function bridgeAmount(env: GasBridgeEnv, token: Address): Promise<bigint> {
  const balance = await env.srcChain.getErc20Balance(token, env.accountAddr);
  return balance < env.amountCap ? balance : env.amountCap;
}

/**
 * Build both legs and classify each against the owner's live grants on the source chain (in leg
 * order, so the FIRST uncovered leg is reported); then run the bridge-gate against the decoded burn.
 */
export async function precheckGasBridge(env: GasBridgeEnv, token: Address): Promise<GasBridgePrecheck> {
  const s = setup(env);
  if (!s) return { ok: false, kind: 'unavailable', reason: 'no CCTP lane between these chains' };
  if (env.srcChainConfig.chainId === env.destChainId) return { ok: false, kind: 'unavailable', reason: 'source and destination are the same chain' };
  const amount = await bridgeAmount(env, token);
  if (amount <= 0n) return { ok: false, kind: 'unavailable', reason: 'nothing to bridge: token balance is zero on the source chain' };

  const self = env.accountAddr.toLowerCase() as Address;
  const { approve, burn } = buildCctpBurnCalls({ self, tokenMessenger: s.messenger, burnToken: token, destinationDomain: s.domain, amount });
  const grant = await loadGrantState(env.pool, env.srcChain, env.agentId, env.accountAddr, new Set([s.messenger]));
  let burnGate: GateResult | null = null;
  for (const call of [approve, burn]) {
    const gate = classifyIntendedCall(call.target, call.value, call.data, grant, self);
    const lane = gate.classification;
    if (lane.lane === 'l2') return { ok: false, kind: 'l2', leg: call.leg, gate };
    if (lane.lane === 'forbidden') return { ok: false, kind: 'forbidden', leg: call.leg, reason: lane.reason };
    if (call.leg === 'burn') burnGate = gate;
  }
  try {
    await env.assertRoutable(s.messenger, burnGate?.decoded);
  } catch (err) {
    return { ok: false, kind: 'forbidden', leg: 'burn', reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, amount, messenger: s.messenger, domain: s.domain };
}

export interface GasBridgeExecInput {
  sessionPrivateKey: string;
  token: Address;
  amount: bigint;
}

/**
 * Run approve -> burn with the SESSION key on the source chain. The rail row exists before the first
 * broadcast; the burn hash is written ahead; a failed leg marks the row failed (nothing was burned
 * unless the burn itself landed, in which case the row is already `initiated` with its hash). Returns
 * the rail id and both hashes. No retry loop - the next cycle re-plans from chain state.
 */
export async function executeGasBridge(env: GasBridgeEnv, input: GasBridgeExecInput): Promise<{ railId: string; txHashes: string[] }> {
  const s = setup(env);
  if (!s) throw new GasBridgeLegError('approve', new Error('no CCTP lane between these chains'), '');
  const self = env.accountAddr.toLowerCase() as Address;
  const { approve, burn } = buildCctpBurnCalls({
    self,
    tokenMessenger: s.messenger,
    burnToken: input.token,
    destinationDomain: s.domain,
    amount: input.amount,
  });
  const row = await initiateRailTransfer(env.pool, {
    agentId: env.agentId,
    accountAddr: self,
    rail: 'cctp',
    srcChainId: env.srcChainConfig.chainId,
    destChainId: env.destChainId,
    asset: input.token,
    amountWei: input.amount.toString(),
    destGasPlan: { destChainId: env.destChainId, fundedWei: env.fillGasWei.toString(), source: 'ops_fill' },
  });
  const txHashes: string[] = [];
  for (const call of [approve, burn]) {
    try {
      const { txHash } = await env.srcChain.executeCall({
        sessionPrivateKey: input.sessionPrivateKey,
        accountAddr: env.accountAddr,
        target: call.target,
        valueWei: call.value,
        data: call.data,
      });
      txHashes.push(txHash);
      if (call.leg === 'burn') await recordSourceSubmitted(env.pool, row.railId, txHash);
    } catch (err) {
      await markFailed(env.pool, row.railId, `${call.leg} leg failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      throw new GasBridgeLegError(call.leg, err, row.railId);
    }
  }
  return { railId: row.railId, txHashes };
}
