import type { Pool } from 'pg';
import { setAgentStatus, getAgentById } from '../store/agents.js';
import type { AlertService } from '../alerts/service.js';
import { appendTrace } from '../trace/trace-store.js';
import type { SseHub } from '../sse/hub.js';
import { statusEvent, traceEvent } from '../sse/events.js';

export interface RevokeFanoutDeps {
  pool: Pool;
  hub: SseHub;
  runtime: { haltForRevoke(agentId: string): Promise<void> };
  /**
   * Phase-2 coordination fan-out (spec §3b): cancels the revoked agent's open
   * delegations (outbound cancelled, inbound declined/failed, all traced).
   * Optional so pre-coordination callers/tests stay valid — BOTH production
   * trigger paths (guardian API + on-chain watcher) pass it.
   */
  coordinator?: { cancelForRevokedAgent(agentId: string): Promise<void> };
  /** Phase-3 daily loop: the revoked info alert (optional for older tests). */
  alerts?: AlertService | undefined;
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
  // Coordination fan-out BEFORE the revoke trace would also be defensible;
  // after keeps the 'revoke' record first on the chain (cause before effects).
  const rec = await appendTrace(deps.pool, { agentId, kind: 'revoke', detail: { source } });
  deps.hub.emit(agentId, 'trace', traceEvent(rec));
  deps.hub.emit(agentId, 'status', statusEvent('revoked'));
  if (deps.coordinator) await deps.coordinator.cancelForRevokedAgent(agentId);
  if (deps.alerts) {
    const agent = await getAgentById(deps.pool, agentId);
    if (agent) {
      await deps.alerts.emit(agent.ownerAddr, {
        agentId,
        class: 'info',
        kind: 'revoked',
        summary: `${agent.name} was revoked (${source === 'guardian-api' ? 'one-click revoke' : 'owner wallet, seen on-chain'})`,
        refs: { traceSeq: rec.seq },
      });
    }
  }
}
