// File: backend/src/runtime/sense-direction.ts
// Phase-5.5 spine (1), the one NEW runtime mechanism (S23, deepest coverage): a
// `sense_direction` step spliced at the HEAD of every agent graph. It applies an
// owner-confirmed directive at the CYCLE BOUNDARY only — never mid-cycle — so a
// running loop reroutes cleanly to the new intent without clobbering in-flight
// work. Because downstream nodes read `ctx.goal` dynamically, mutating ctx.goal
// here reroutes THIS and every subsequent cycle; because it runs at the head of
// each fresh cycle, an in-flight cycle is never touched.
//
// R-1 (apply boundary): the confirmed EFFECTIVE goal is re-validated against the
// live goal union + role-lock before it is written — a tampered/out-of-union
// effective goal is consumed WITHOUT changing the running goal (traced as a
// rejection), never merged.

import type { Pool } from 'pg';
import type { SseHub } from '../sse/hub.js';
import { traceEvent } from '../sse/events.js';
import { appendTrace } from '../trace/trace-store.js';
import { updateAgentGoal } from '../store/agents.js';
import { listConfirmedUnapplied, markDirectionApplied } from '../store/directions.js';
import { revalidateEffectiveGoal } from '../direction/goal-schema.js';
import type { AgentGoal } from '../types.js';

export interface SenseDirectionDeps {
  pool: Pool;
  hub?: SseHub | undefined;
}

/** The minimal mutable context the node needs — shared by the treasury + job graphs. */
export interface DirectableContext {
  agentId: string;
  goal: AgentGoal;
}

/**
 * Build the head node. Returns a LangGraph node fn `(state) => {}` that never
 * modifies graph state (it changes ctx.goal + the DB), so it composes as
 * `START -> sense_direction -> <existing first node>`.
 */
export function makeSenseDirection(deps: SenseDirectionDeps, ctx: DirectableContext) {
  return async function senseDirection(): Promise<Record<string, never>> {
    const [dir] = await listConfirmedUnapplied(deps.pool, ctx.agentId, 1);
    if (!dir) return {};
    const check = revalidateEffectiveGoal(ctx.goal, dir.effectiveGoal);
    if (check.ok) {
      // Reroute the running loop (in-memory) AND persist (owner-authored write).
      ctx.goal = check.goal;
      await updateAgentGoal(deps.pool, ctx.agentId, check.goal);
    }
    const rec = await appendTrace(deps.pool, {
      agentId: ctx.agentId,
      kind: 'direction',
      detail: check.ok
        ? { summary: `applied owner direction: ${dir.draft.understanding}`, directionId: dir.id, applied: true }
        : { summary: 'owner direction rejected at apply (out-of-union) — no change', directionId: dir.id, applied: false, reason: check.reason },
    });
    deps.hub?.emit(ctx.agentId, 'trace', traceEvent(rec));
    // Consume the directive either way (idempotent CAS) so it never re-applies.
    await markDirectionApplied(deps.pool, dir.id);
    return {};
  };
}
