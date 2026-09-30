import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import type { DecodedLeashError } from '../types.js';
import type { Json } from '../crypto/canonical.js';
import { computeCallHash, decodeCall, BRIDGE_SELECTORS } from '../governed-call/index.js';
import { claimOneShotConsumption, finalizeOneShotConsumption } from '../store/capabilities.js';
import { decodeLeashError } from '../chain/errors.js';
import { appendTrace } from '../trace/trace-store.js';
import { traceEvent } from '../sse/events.js';
import type { RuntimeChain } from './session-chain.js';

/**
 * SE-2 (SD-E2) — the runtime one-shot-consume path. Stage D recorded an
 * approve-once decision but never submitted (F-D2): the on-chain one-shot
 * (`oneShotAuthEta[callHash]`, set by the owner's `authorizeOnce`) sat unconsumed
 * until it expired. This is the missing runtime action: after the owner picks
 * approve_once, auto-retry the originally-refused call and consume the on-chain
 * one-shot EXACTLY ONCE.
 *
 * Guarantees (spec E-3):
 *  - consume-once: the exact refused bytes land; the on-chain wall deletes the
 *    one-shot on use (delete-on-use), so a replay is refused on-chain.
 *  - replay-refused off-chain too: the CAS claim (pending → consuming) means a
 *    second attempt gets null and stands down (audit shows consume-once).
 *  - mid-cycle revoke/expiry abort (P3C-6 no-doomed-submit): revoke/expiry AND
 *    the live on-chain one-shot ETA are re-read at submit time; a stale leash
 *    stands down without a doomed submit.
 *  - fail-safe: a reverted/flaked receipt is a FAILED decision, never a phantom
 *    action (assertReceiptSuccess throws on non-success; we record `failed`).
 */
export interface OneShotConsumeDeps {
  pool: Pool;
  hub: SseHub;
  chain: RuntimeChain;
  /**
   * SE-8 (E-12 red-team fix): the bridge pre-routing gate for a BRIDGE one-shot.
   * The one-shot lane bypasses `_checkStructuredArgs` on-chain (owner-signed
   * exact bytes), so the same-address rail is re-imposed HERE before submit.
   * Absent = bridge one-shots REFUSE (fail-closed) — wired by the manager from
   * `ChainRegistry` (`assertBridgeRoutable`).
   */
  bridgeGuard?: ((bridgeTarget: string) => Promise<unknown>) | undefined;
}

export interface OneShotConsumeCtx {
  agentId: string;
  accountAddr: string;
  /** the scoped session key — the ONLY signing material the runtime holds. */
  sessionPrivateKey: string;
}

export type ConsumeOutcome =
  | { type: 'consumed'; txHash: string }
  // `retryable` = a TRANSIENT stand-down (the one-shot isn't live on-chain yet —
  // the owner's authorizeOnce tx is likely still confirming). The caller may
  // re-attempt (the request is left `aborted`, i.e. re-claimable). Every other
  // stand-down (revoked / expired / bytes) is terminal for this one-shot.
  | { type: 'stood_down'; reason: string; retryable: boolean }
  | { type: 'failed'; reason: string; decoded?: DecodedLeashError };

export async function consumeOneShot(
  deps: OneShotConsumeDeps,
  ctx: OneShotConsumeCtx,
  requestId: string,
): Promise<ConsumeOutcome> {
  // 1. CAS claim — only an approved_once, un-consumed request proceeds. A replay
  //    or a concurrent retry gets null here (already consuming/consumed/failed).
  const req = await claimOneShotConsumption(deps.pool, requestId);
  if (!req) return { type: 'stood_down', reason: 'one-shot not approvable or already consumed', retryable: false };

  const standDown = async (reason: string, retryable = false): Promise<ConsumeOutcome> => {
    // Stale grant/revoke/expiry — release the claim (re-claimable) + trace it.
    await finalizeOneShotConsumption(deps.pool, requestId, 'aborted');
    await trace(deps, ctx.agentId, 'decision', { summary: `one-shot consume stood down: ${reason}` });
    return { type: 'stood_down', reason, retryable };
  };

  // 2. The exact refused bytes must be present (server-authored, bound by callHash).
  if (req.callTarget === null || req.callData === null || req.callValue === null) {
    return standDown('no stored call bytes to retry');
  }
  const target = req.callTarget;
  const value = BigInt(req.callValue);
  const data = req.callData;

  // 3. Integrity: the stored bytes must reproduce the authorized callHash (D-7).
  if (computeCallHash(target, value, data).toLowerCase() !== req.callHash.toLowerCase()) {
    return standDown('call bytes do not reproduce the authorized one-shot hash');
  }

  // 3b. SE-8 (E-12): a BRIDGE one-shot bypasses the on-chain structured decoder
  //     (the wall trusts the owner-signed exact bytes), so the cross-chain
  //     same-address rail is enforced here: the decoded recipient must be the
  //     account ITSELF, and the pre-routing gate (assertSameAddress on home +
  //     destination via assertBridgeRoutable) must pass. Fail-closed on both.
  const oneShotSelector = data.slice(0, 10).toLowerCase();
  if (BRIDGE_SELECTORS.has(oneShotSelector)) {
    const decoded = decodeCall(target, value, data);
    const recipients = decoded.args.recipients.map((r) => r.toLowerCase());
    if (decoded.reject !== undefined || recipients.length !== 1 || recipients[0] !== ctx.accountAddr.toLowerCase()) {
      return standDown('bridge one-shot refused: recipient is not the same-address account (SE-8 rail)');
    }
    if (!deps.bridgeGuard) {
      return standDown('bridge one-shot refused: no bridge pre-routing gate configured (fail-closed)');
    }
    try {
      await deps.bridgeGuard(target);
    } catch (err) {
      return standDown(
        `bridge one-shot refused by the pre-routing gate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Freshness re-check at submit time (P3C-6). getPolicyView is a required
  //    RuntimeChain read; the one-shot ETA is an optional read (prod implements
  //    it — a fake may omit it, and the on-chain wall stays the ultimate guard).
  const policy = await deps.chain.getPolicyView(ctx.accountAddr, []);
  const nowSec = Math.floor(Date.now() / 1000);
  if (policy.revoked) return standDown('account revoked since approval — not consuming');
  if (policy.expiresAt <= nowSec) return standDown('session expired since approval — not consuming');
  if (deps.chain.readOneShotAuth) {
    const eta = await deps.chain.readOneShotAuth(ctx.accountAddr, req.callHash);
    // eta 0 = not authorized on-chain: either the owner's authorizeOnce tx is
    // still confirming (transient → retryable) or it was revoked/consumed. The
    // bounded caller-side retry catches the "still confirming" case; a genuinely
    // gone one-shot just exhausts the retries harmlessly (the wall guards anyway).
    if (eta === 0n) return standDown('one-shot not yet authorized on-chain (authorizeOnce confirming?)', true);
    if (BigInt(nowSec) > eta) return standDown('one-shot expired on-chain — not consuming');
  }

  // 5. Submit the exact bytes — the on-chain wall consumes the one-shot once.
  //    A revert/flake throws (assertReceiptSuccess): fail-safe failed-not-acted.
  try {
    const { txHash } = await deps.chain.executeCall({
      sessionPrivateKey: ctx.sessionPrivateKey,
      accountAddr: ctx.accountAddr,
      target,
      valueWei: value,
      data,
    });
    await finalizeOneShotConsumption(deps.pool, requestId, 'consumed', txHash);
    await trace(deps, ctx.agentId, 'action', {
      to: target,
      valueWei: req.callValue,
      txHash,
      summary: `consumed approve-once one-shot: governed call to ${target}${value !== 0n ? ` (${req.callValue} wei)` : ''}`,
    });
    return { type: 'consumed', txHash };
  } catch (err) {
    // Never a phantom action: NEVER mark consumed on a throw. But distinguish the
    // two failure modes (M-01, SE-5.0):
    //  - a DECODED LeashError revert is a genuine on-chain refusal → terminal
    //    `failed` (re-approving is the owner's call; an auto-retry would only
    //    revert again against the same wall state).
    //  - an UNDECODABLE throw is a transport blip (RPC flake / nonce / gas /
    //    dropped receipt). The owner's authorizeOnce may well have landed; a
    //    terminal `failed` here would silently waste a valid approval. So leave it
    //    `aborted` (re-claimable) and report `retryable` — the bounded caller-side
    //    retry recovers the transient case; a genuinely non-transient error just
    //    exhausts the retries harmlessly (the on-chain wall is the ultimate guard).
    const decoded = decodeLeashError(err);
    if (decoded) {
      await finalizeOneShotConsumption(deps.pool, requestId, 'failed');
      const reason = `one-shot consume refused: ${decoded.plain}`;
      await trace(deps, ctx.agentId, 'decision', {
        summary: reason,
        decoded: { ...decoded } as unknown as Json,
      });
      return { type: 'failed', reason, decoded };
    }
    await finalizeOneShotConsumption(deps.pool, requestId, 'aborted');
    const reason = `one-shot consume hit a transport error (re-claimable): ${err instanceof Error ? err.message : String(err)}`;
    await trace(deps, ctx.agentId, 'decision', { summary: reason });
    return { type: 'stood_down', reason, retryable: true };
  }
}

async function trace(
  deps: OneShotConsumeDeps,
  agentId: string,
  kind: 'action' | 'decision',
  detail: Json,
): Promise<void> {
  const rec = await appendTrace(deps.pool, { agentId, kind, detail });
  deps.hub.emit(agentId, 'trace', traceEvent(rec));
}
