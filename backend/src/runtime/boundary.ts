import type { PolicySnapshot } from './prompt.js';

/**
 * P3C-6(iii): futile-retry damping. When an act hits a POLICY boundary
 * (window / per-transfer / allowlist / expiry — decoded or pre-flight), the
 * runtime records the active boundary; while it is active, decide outcomes
 * that would re-hit it short-circuit to a traced stand-down WITHOUT an act
 * attempt (no gas, no futile tx). The boundary clears on window reset,
 * policy change (fingerprint), or re-arm — clearing re-enables normal flow.
 *
 * In-memory per process: a restart re-detects the boundary on the next
 * doomed attempt at the cost of ONE tx; the limit_hit alert stays deduped in
 * the DB by its boundary key regardless.
 */

export const DAMPABLE_ERRORS = ['OverWindowCap', 'OverPerTransferCap', 'NotAllowlisted', 'SessionExpired'] as const;
export type DampableError = (typeof DAMPABLE_ERRORS)[number];

export interface ActiveBoundary {
  errorName: DampableError;
  /** Unix seconds after which the boundary self-clears (window reset); null = policy-change-only. */
  clearsAtUnix: number | null;
  /** Policy fingerprint at activation — ANY policy change clears the boundary. */
  policyFingerprint: string;
  /** The alert dedup key this activation emitted under (resolve on clear). */
  dedupKey: string;
  activatedAtUnix: number;
}

export function policyFingerprint(p: PolicySnapshot): string {
  return [p.perTransferCapWei, p.windowCapWei, String(p.windowSeconds), String(p.expiresAt), ...p.allowlist].join('|');
}

export class BoundaryRegistry {
  private readonly active = new Map<string, ActiveBoundary>();

  get(agentId: string): ActiveBoundary | null {
    return this.active.get(agentId) ?? null;
  }

  set(agentId: string, boundary: ActiveBoundary): void {
    this.active.set(agentId, boundary);
  }

  clear(agentId: string): ActiveBoundary | null {
    const b = this.active.get(agentId) ?? null;
    this.active.delete(agentId);
    return b;
  }

  /**
   * Evaluate clear conditions against the CURRENT policy snapshot: window
   * reset (time), ANY policy change (fingerprint), or re-arm. 'cleared'
   * carries the old boundary so the caller can resolve its limit_hit alert.
   */
  refresh(
    agentId: string,
    policy: PolicySnapshot,
    nowSec: number,
  ): { status: 'none' } | { status: 'active'; boundary: ActiveBoundary } | { status: 'cleared'; boundary: ActiveBoundary } {
    const b = this.active.get(agentId);
    if (!b) return { status: 'none' };
    const changed = policyFingerprint(policy) !== b.policyFingerprint;
    const timeCleared = b.clearsAtUnix !== null && nowSec >= b.clearsAtUnix;
    const rearmed = b.errorName === 'SessionExpired' && policy.expiresAt > nowSec;
    if (changed || timeCleared || rearmed) {
      this.active.delete(agentId);
      return { status: 'cleared', boundary: b };
    }
    return { status: 'active', boundary: b };
  }
}
