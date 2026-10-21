import type { Pool } from 'pg';
import type { AgentGoal, AgentRole, TraceRecord } from '../types.js';
import { goalRole } from '../types.js';
import type { AgentDecision, PolicySnapshot, TraderHoldings } from './prompt.js';
import { formatG } from '../util/format.js';

/**
 * AQ-A1 · D-1/D-2 — the server-composed cross-cycle carry and the sense→decide
 * boundary instrument.
 *
 * The decision cycle was MEASURED memoryless (RESEARCH-NOTES §1c-1): working memory is written
 * every cycle but read back by nothing in the reasoning path, so each 30s cycle re-decides blind.
 * It cannot notice "I topped this up 10 minutes ago and the balance still fell" (a drain), cannot
 * see its own repeated failures, and the corrected band-trader metric (decision quality per
 * OBSERVED CHANGE, not per 30s tick) is unmeasurable because nothing computes what changed.
 *
 * This module adds exactly that signal, as SERVER DATA — the same trust class as `display.*`, never
 * model text. Two coupled deliverables share one substrate:
 *   D-2  a compact, server-authored `SenseSnapshot` of the decision-relevant sensed values, plus
 *        `actionPossible`/`observedChange`, recorded on every decision/action trace record. This IS
 *        the corrected-metric substrate (the F-0a-2 hand-off names A1) — it makes stand-down-rate
 *        conditioned on action-possible cycles a durable SQL question.
 *   D-1  `CycleMemory` — last decision + its outcome + how long ago, the signed delta since that
 *        cycle, and outcome counts over a rolling window — rebuilt each cycle from the agent's OWN
 *        trace records. No accumulation: only this fixed-size carry plus the current observation
 *        ever reach the model (the masking policy — decisions/outcomes forward, never prior raw
 *        observations, RESEARCH-NOTES §3b).
 *
 * Deliberately NOT a new table: the trace chain already persists one record per cycle, so the
 * previous cycle's snapshot lives on the previous record. The only fidelity gap is a sentinel that
 * delegates successfully every cycle (the coordinator writes that trace, without `detail.cycle`) —
 * there `delta` falls back to the most recent snapshot-bearing cycle and `lastCycle` still reflects
 * the real most-recent trace. Absence/staleness is rendered honestly, never fabricated (D-1 law).
 */

/**
 * The per-cycle outcome, reduced to the classes the carry reasons over. Distinct from
 * `CycleOutcome` (the runtime's full union) — this is the owner/model-legible summary.
 */
export type MemoryOutcome =
  | 'landed' // a transfer or governed call that reached the chain
  | 'reverted' // the on-chain wall / RPC refused it (a genuine boundary hit)
  | 'blocked' // damped pre-flight (window exhausted / active boundary) — never reached the chain
  | 'parse_failed' // the model output was not a valid decision (mechanical, F-4)
  | 'stood_down' // a reasoned refusal to act
  | 'delegated' // a sentinel request handed to its executor
  | 'denied'; // the owner denied an over-cap transfer

/**
 * The decision-relevant sensed values of ONE cycle, persisted on its trace record so the NEXT
 * cycle can diff against it. Compact by construction — a handful of base-unit integers plus a
 * capability-set fingerprint, never the whole observation (that would re-accumulate raw sensor
 * state, the exact thing the masking policy forbids).
 */
export interface SenseSnapshot {
  beneficiaryBalanceWei: string;
  accountBalanceWei: string;
  remainingWindowWei: string;
  /** Stable fingerprint of the capability envelope (count + sorted selectors): a cheap did-the-grant-set-change signal. */
  capabilitiesKey: string;
  /** Trader only — its decision turns on token holdings, not a beneficiary balance. */
  holdBalanceWei?: string;
  spendBalanceWei?: string;
  routerAllowanceWei?: string;
}

/** D-2 instruments + the snapshot, written under `detail.cycle` on every record()-path trace. */
export interface CycleRecord {
  action: AgentDecision['action'];
  amountWei: string;
  outcome: MemoryOutcome;
  /** D-2: was a legitimate action available this cycle (per-role predicate)? The metric's denominator. */
  actionPossible: boolean;
  /** D-2: did anything decision-relevant move since the previous cycle? The metric's gate. */
  observedChange: boolean;
  /** D-3: the model call's input size (usage.prompt_tokens), recorded so budget conformance is a SQL question. */
  promptTokens: number | null;
  snapshot: SenseSnapshot;
}

/**
 * D-1 — the cross-cycle carry fed into the observation. Raw base-unit integers (the rules compare
 * these); `display.cycleMemory` renders the human words alongside, the same split as every other
 * amount (D-3 doctrine). Absent on the first cycle and after a trace gap.
 */
export interface CycleMemory {
  lastCycle: {
    action: AgentDecision['action'];
    amountWei: string;
    outcome: MemoryOutcome;
    agoSeconds: number;
  };
  /** Signed diffs (current − previous). Null when there is no prior snapshot to diff against. */
  delta: {
    beneficiaryBalanceWei: string;
    accountBalanceWei: string;
    remainingWindowWei: string;
    capabilitiesChanged: boolean;
  } | null;
  recentOutcomes: { window: number; sends: number; standDowns: number; failures: number; blocked: number };
}

/**
 * AQ-A1 D-1 ROUND 2 — the flag-shaped carry. Round 1 proved the PROSE carry regresses G-1 (it
 * inflates deliberation on 0gm and truncates 40–52% of cycles — see AQ-A1-BUILD-RESULTS.md). The
 * fix direction the data pointed at (shorter carry truncates less) is taken to its limit here: the
 * model is handed NOT a block to re-read but two server-DERIVED booleans the mechanical rules consume
 * in one clause each — signal without deliberation load.
 *
 * The two flags are chosen to drive exactly the decision-FLIP scenarios while leaving the non-flip
 * ones (drain, stale-window) untouched:
 *  - `recentFailureStreak`: recent sends keep reverting → do not blindly resend (repeated-failure).
 *  - `justToppedUp`: a send LANDED moments ago AND the beneficiary balance actually ROSE → the top-up
 *    is still settling, don't double-send (redundant-top-up). The `delta > 0` guard is what EXCLUDES
 *    a drain (balance fell despite a landed send) — there the agent must keep funding, so no flag.
 */
export interface CycleFlags {
  recentFailureStreak: boolean;
  justToppedUp: boolean;
}

export function deriveCycleFlags(cm: CycleMemory): CycleFlags {
  const last = cm.lastCycle;
  const recentFailureStreak = cm.recentOutcomes.failures >= 2 || last.outcome === 'reverted';
  const beneficiaryRose = cm.delta !== null && BigInt(cm.delta.beneficiaryBalanceWei) > 0n;
  const justToppedUp = last.action === 'send' && last.outcome === 'landed' && last.agoSeconds < 90 && beneficiaryRose;
  return { recentFailureStreak, justToppedUp };
}

/** Stable, order-independent fingerprint of the prompt-visible capability set. */
export function capabilitiesKey(caps: Array<{ selector: string }>): string {
  if (caps.length === 0) return '0:';
  return `${caps.length}:${caps.map((c) => c.selector.toLowerCase()).sort().join(',')}`;
}

/** Two snapshots differ on any decision-relevant field they share. */
export function snapshotsDiffer(a: SenseSnapshot, b: SenseSnapshot): boolean {
  if (a.capabilitiesKey !== b.capabilitiesKey) return true;
  if (a.beneficiaryBalanceWei !== b.beneficiaryBalanceWei) return true;
  if (a.accountBalanceWei !== b.accountBalanceWei) return true;
  if (a.remainingWindowWei !== b.remainingWindowWei) return true;
  // Trader fields: only compare when BOTH carry them (a treasury→trader role change is a gap, not a diff).
  if (a.holdBalanceWei !== undefined && b.holdBalanceWei !== undefined && a.holdBalanceWei !== b.holdBalanceWei) return true;
  if (a.spendBalanceWei !== undefined && b.spendBalanceWei !== undefined && a.spendBalanceWei !== b.spendBalanceWei) return true;
  if (a.routerAllowanceWei !== undefined && b.routerAllowanceWei !== undefined && a.routerAllowanceWei !== b.routerAllowanceWei)
    return true;
  return false;
}

/**
 * D-2 — the per-role action-possible predicate, computed deterministically in the sense node from
 * the sensed facts (never the model). "Could the agent legitimately act this cycle?" This is the
 * denominator the corrected metric conditions on: a stand-down when NO action was possible is
 * correct and must not count against the agent; a stand-down when one WAS possible is the signal.
 */
export interface ActionPossibleInput {
  goal: AgentGoal;
  policy: PolicySnapshot;
  beneficiaryBalanceWei: string;
  accountBalanceWei: string;
  effectiveBeneficiary: string;
  holdings?: TraderHoldings | null | undefined;
  capabilitiesCount: number;
  hasInbound: boolean;
  nowSec: number;
}

export function computeActionPossible(input: ActionPossibleInput): boolean {
  const role: AgentRole = goalRole(input.goal);
  const { policy, nowSec } = input;
  const live = !policy.revoked && (policy.expiresAt === 0 || policy.expiresAt > nowSec);
  if (!live) return false;

  if (role === 'sentinel') {
    // Spend-incapable: its own caps never bound its REQUEST. Action is possible iff the beneficiary
    // is below target (its goal carries the target).
    if (input.goal.type !== 'sentinel') return false;
    return BigInt(input.beneficiaryBalanceWei) < BigInt(input.goal.targetBalanceWei);
  }

  if (role === 'executor') {
    // Inbound-driven: autonomous cycles can never act; an inbound request can act iff funded + window.
    return input.hasInbound && BigInt(policy.remainingWindowWei) > 0n && BigInt(input.accountBalanceWei) > 0n;
  }

  if (role === 'trader') {
    if (input.goal.type !== 'trader') return false;
    if (input.capabilitiesCount === 0) return false;
    const h = input.holdings;
    if (!h) return false;
    if (BigInt(h.holdBalanceWei) >= BigInt(input.goal.targetHoldWei)) return false;
    // Fundable iff it holds at least one clip of the spend token to eventually swap (approve is the
    // precursor rung to swapping that clip).
    return BigInt(h.spendBalanceWei) >= BigInt(input.goal.clipWei);
  }

  // treasury
  if (input.goal.type !== undefined && input.goal.type !== 'treasury') return false;
  const target = BigInt(input.goal.targetBalanceWei);
  if (BigInt(input.beneficiaryBalanceWei) >= target) return false;
  if (BigInt(policy.remainingWindowWei) <= 0n) return false;
  if (!policy.allowlist.includes(input.effectiveBeneficiary.toLowerCase())) return false;
  // Must be able to fund at least the smaller of the top-up and what the target still needs.
  const need = target - BigInt(input.beneficiaryBalanceWei);
  const topUp = BigInt(input.goal.topUpWei);
  const minMove = need < topUp ? need : topUp;
  return BigInt(input.accountBalanceWei) >= minMove && minMove > 0n;
}

/** Map a runtime `CycleOutcome.type` + its reason to the carry's reduced outcome vocabulary. */
export function classifyOutcome(
  outcomeType: string,
  reason: string | undefined,
  parseMissReason: string,
): MemoryOutcome {
  switch (outcomeType) {
    case 'acted':
      return 'landed';
    case 'delegated':
      return 'delegated';
    case 'denied':
      return 'denied';
    case 'failed':
      return 'reverted';
    case 'stood_down':
      if (reason === parseMissReason) return 'parse_failed';
      if (reason && /\bboundary active\b|window exhausted|remaining window allowance/i.test(reason)) return 'blocked';
      return 'stood_down';
    default:
      return 'stood_down';
  }
}

/** Pull `detail.cycle` off a trace record if the runtime wrote one (new records always do). */
function readCycle(trace: TraceRecord): CycleRecord | null {
  const detail = trace.detail as { cycle?: unknown } | undefined;
  const c = detail?.cycle as Partial<CycleRecord> | undefined;
  if (!c || typeof c !== 'object' || !c.snapshot || !c.action || !c.outcome) return null;
  return c as CycleRecord;
}

/**
 * Classify a trace that predates `detail.cycle` (or was written by the coordinator, e.g. a
 * sentinel's `delegate` trace). Coarse but honest — only `kind` is trustworthy here.
 */
function classifyLegacyTrace(trace: TraceRecord): { action: AgentDecision['action']; amountWei: string; outcome: MemoryOutcome } | null {
  if (trace.kind === 'delegate') {
    const d = trace.detail as { payload?: { amountWei?: string } } | undefined;
    return { action: 'send', amountWei: d?.payload?.amountWei ?? '0', outcome: 'delegated' };
  }
  if (trace.kind === 'action') return { action: 'send', amountWei: '0', outcome: 'landed' };
  if (trace.kind === 'decision') return { action: 'stand_down', amountWei: '0', outcome: 'stood_down' };
  return null;
}

const MOVE_OUTCOMES = new Set<MemoryOutcome>(['landed', 'delegated']);
const FAIL_OUTCOMES = new Set<MemoryOutcome>(['reverted', 'parse_failed', 'denied']);

/**
 * Build the D-1 carry + surface the most recent snapshot, from the agent's own recent trace records
 * (newest-first). Pure — the DB read lives in `loadCycleMemory`.
 */
export function buildCycleMemory(
  recentTracesDesc: TraceRecord[],
  nowSec: number,
  window = 10,
): { cycleMemory: CycleMemory | null; baselineSnapshot: SenseSnapshot | null } {
  const head = recentTracesDesc[0];
  if (!head) return { cycleMemory: null, baselineSnapshot: null };

  // lastCycle: the single most recent trace (cycle record preferred; else a coarse legacy classify).
  const headCycle = readCycle(head);
  const headLegacy = headCycle
    ? { action: headCycle.action, amountWei: headCycle.amountWei, outcome: headCycle.outcome }
    : classifyLegacyTrace(head);
  if (!headLegacy) return { cycleMemory: null, baselineSnapshot: null };

  const headTsSec = Math.floor(new Date(head.ts).getTime() / 1000);
  const agoSeconds = Math.max(0, nowSec - headTsSec);

  // baseline snapshot: the most recent trace that carries one (may be older than head for a
  // delegate-streak sentinel). Used for the delta only.
  let baselineSnapshot: SenseSnapshot | null = null;
  for (const t of recentTracesDesc) {
    const c = readCycle(t);
    if (c) {
      baselineSnapshot = c.snapshot;
      break;
    }
  }

  // recentOutcomes: classify up to `window` traces.
  let sends = 0;
  let standDowns = 0;
  let failures = 0;
  let blocked = 0;
  for (const t of recentTracesDesc.slice(0, window)) {
    const c = readCycle(t);
    const outcome = c?.outcome ?? classifyLegacyTrace(t)?.outcome;
    if (!outcome) continue;
    if (MOVE_OUTCOMES.has(outcome)) sends++;
    else if (outcome === 'stood_down') standDowns++;
    else if (outcome === 'blocked') blocked++;
    else if (FAIL_OUTCOMES.has(outcome)) failures++;
  }

  return {
    cycleMemory: {
      lastCycle: {
        action: headLegacy.action,
        amountWei: headLegacy.amountWei,
        outcome: headLegacy.outcome,
        agoSeconds,
      },
      delta: null, // filled by the sense node once it has the CURRENT snapshot (see `computeDelta`)
      recentOutcomes: { window, sends, standDowns, failures, blocked },
    },
    baselineSnapshot,
  };
}

/** Signed delta (current − baseline). Null baseline ⇒ no delta (first cycle / trace gap). */
export function computeDelta(current: SenseSnapshot, baseline: SenseSnapshot | null): CycleMemory['delta'] {
  if (!baseline) return null;
  const diff = (cur: string, base: string) => (BigInt(cur) - BigInt(base)).toString();
  return {
    beneficiaryBalanceWei: diff(current.beneficiaryBalanceWei, baseline.beneficiaryBalanceWei),
    accountBalanceWei: diff(current.accountBalanceWei, baseline.accountBalanceWei),
    remainingWindowWei: diff(current.remainingWindowWei, baseline.remainingWindowWei),
    capabilitiesChanged: current.capabilitiesKey !== baseline.capabilitiesKey,
  };
}

/** 'in N min/s ago' phrasing for the owner/model surface. */
function agoHuman(sec: number): string {
  if (sec < 90) return `${Math.max(1, sec)}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function actionHuman(action: AgentDecision['action'], amountWei: string, outcome: MemoryOutcome): string {
  if (outcome === 'stood_down' || outcome === 'blocked') return outcome === 'blocked' ? 'was blocked' : 'stood down';
  if (outcome === 'parse_failed') return 'produced no valid decision';
  switch (action) {
    case 'send':
      return outcome === 'delegated' ? `requested ${formatG(amountWei)}` : `sent ${formatG(amountWei)}`;
    case 'call':
      return 'made a governed call';
    case 'tool_call':
      return 'used a tool';
    case 'sign':
      return 'armed a signing intent';
    default:
      return 'stood down';
  }
}

/**
 * D-1/D-3 doctrine — the human words for the carry, rendered server-side exactly like every other
 * amount so the agent's own words match what the owner reads elsewhere. Native-0G only (the
 * balance/window deltas are native; a trader's token holdings are handled by TOKEN_AMOUNT_RULES).
 */
export function renderCycleMemoryDisplay(cm: CycleMemory): Record<string, string> {
  const d: Record<string, string> = {
    lastAction: actionHuman(cm.lastCycle.action, cm.lastCycle.amountWei, cm.lastCycle.outcome),
    lastOutcome: cm.lastCycle.outcome,
    lastWhen: agoHuman(cm.lastCycle.agoSeconds),
    recent: `${cm.recentOutcomes.sends} sends, ${cm.recentOutcomes.standDowns} stand-downs, ${cm.recentOutcomes.failures} failures, ${cm.recentOutcomes.blocked} blocked in the last ${cm.recentOutcomes.window} cycles`,
  };
  if (cm.delta) {
    d['deltaBeneficiary'] = formatG(cm.delta.beneficiaryBalanceWei, true);
    d['deltaAccount'] = formatG(cm.delta.accountBalanceWei, true);
    d['deltaRemainingWindow'] = formatG(cm.delta.remainingWindowWei, true);
    d['capabilitiesChanged'] = cm.delta.capabilitiesChanged ? 'yes' : 'no';
  }
  return d;
}

/**
 * Read the agent's own recent trace records (newest-first) and build the D-1 carry + the baseline
 * snapshot for the delta. Bounded read; never throws the cycle (a failure returns empty, and the
 * agent decides normally — absence is honest).
 */
export async function loadCycleMemory(
  pool: Pool,
  agentId: string,
  nowSec: number,
  window = 10,
): Promise<{ cycleMemory: CycleMemory | null; baselineSnapshot: SenseSnapshot | null }> {
  try {
    const res = await pool.query<{ record: TraceRecord }>(
      `SELECT record FROM trace_records WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2`,
      [agentId, window],
    );
    return buildCycleMemory(res.rows.map((r) => r.record), nowSec, window);
  } catch {
    return { cycleMemory: null, baselineSnapshot: null };
  }
}
