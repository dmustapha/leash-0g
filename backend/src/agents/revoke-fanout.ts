import type { Pool } from 'pg';
import { setAgentStatus } from '../store/agents.js';
import { appendTrace } from '../trace/trace-store.js';
import type { SseHub } from '../sse/hub.js';
import { statusEvent, traceEvent } from '../sse/events.js';

export interface RevokeFanoutDeps {
  pool: Pool;
  hub: SseHub;
  runtime: { haltForRevoke(agentId: string): Promise<void> };
}

/**
 * Revoke fan-out (spec §3b): the chain is the hard boundary; this propagates
 * the fail-close to every soft layer — runtime halted, Postgres marked
 * Revoked (which makes the gateway 403 the agent token on its status check),
 * trace record appended, owners notified over SSE. Used by both trigger
 * paths: guardian revoke via the API and an observed on-chain Revoked event.
 */
export async function applyRevokeFanout(
  deps: RevokeFanoutDeps,
  agentId: string,
  source: 'guardian-api' | 'onchain-event',
): Promise<void> {
  await deps.runtime.haltForRevoke(agentId);
  await setAgentStatus(deps.pool, agentId, 'revoked');
  const rec = await appendTrace(deps.pool, { agentId, kind: 'revoke', detail: { source } });
  deps.hub.emit(agentId, 'trace', traceEvent(rec));
  deps.hub.emit(agentId, 'status', statusEvent('revoked'));
}
