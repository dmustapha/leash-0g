import { Router, json, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { ComputeQueue, ComputeResult } from './compute-queue.js';
import { authenticateAgent } from './agent-auth.js';
import { evaluateRules } from './interceptor.js';
import { appendTrace } from '../trace/trace-store.js';
import { createApproval } from '../store/approvals.js';
import type { ApprovalBroker } from '../approvals/broker.js';
import type { SseHub } from '../sse/hub.js';
import { approvalEvent, requestSummary, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import type { AgentRow, TraceRecord } from '../types.js';

export interface GatewayDeps {
  pool: Pool;
  queue: ComputeQueue;
  hub: SseHub;
  broker: ApprovalBroker;
  approvalTimeoutMs: number;
}

const BODY_LIMIT = 256 * 1024; // 256KB JSON cap (M-01)

/**
 * The gateway: OpenAI-compatible reverse proxy to 0G Compute with the
 * interception pipeline (observe | block | modify | require-approval).
 * Exact-path routing only — POST /v1/chat/completions and nothing else.
 */
export function gatewayRouter(deps: GatewayDeps): Router {
  const router = Router();

  router.post('/v1/chat/completions', json({ limit: BODY_LIMIT }), (req, res) => {
    handleCompletion(deps, req, res).catch((err: unknown) => {
      console.error('gateway error', err);
      if (!res.headersSent) res.status(502).json({ error: { message: 'upstream error' } });
    });
  });

  return router;
}

async function handleCompletion(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  const auth = await authenticateAgent(deps.pool, req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.status).json({ error: { message: auth.status === 401 ? 'unauthorized' : 'forbidden' } });
    return;
  }
  const agent = auth.agent;
  const body = req.body as Json;
  const outcome = evaluateRules(agent.gatewayRules, body);

  if (outcome.action === 'block') {
    const rec = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'block',
      originalRequest: body,
      detail: { rule: outcome.rule.match },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(rec));
    res.status(403).json({ error: { message: 'request blocked by policy' } });
    return;
  }

  if (outcome.action === 'require_approval') {
    const approved = await holdForApproval(deps, agent, body, res);
    if (!approved) return; // response already sent (deny/timeout)
    await forwardAndTrace(deps, agent, res, { kind: 'inference', original: body, effective: body });
    return;
  }

  if (outcome.action === 'modify') {
    await forwardAndTrace(deps, agent, res, { kind: 'modify', original: body, effective: outcome.effective });
    return;
  }

  await forwardAndTrace(deps, agent, res, { kind: 'inference', original: body, effective: body });
}

/**
 * Hold the request for the owner. Returns true only after the approve consent
 * record is DURABLY persisted — forwarding awaits the consent write (spec:
 * consent strictly before forward).
 */
async function holdForApproval(deps: GatewayDeps, agent: AgentRow, body: Json, res: Response): Promise<boolean> {
  const approval = await createApproval(deps.pool, agent.id, body);
  deps.hub.emit(agent.id, 'approval', approvalEvent({ approvalId: approval.id, summary: requestSummary(body) }));
  const decision = await deps.broker.wait(approval.id, deps.approvalTimeoutMs);

  if (decision === 'timeout') {
    res.status(408).json({ error: { message: 'approval timed out' } });
    return false;
  }

  // Consent record persisted BEFORE any forwarding — this await is the ordering guarantee.
  const consent = await appendTrace(deps.pool, {
    agentId: agent.id,
    kind: 'consent',
    approvalId: approval.id,
    decision: decision.decision,
    decidedBy: 'owner',
    originalRequest: body,
    ...(decision.reason !== undefined ? { detail: { reason: decision.reason } } : {}),
  });
  deps.hub.emit(agent.id, 'trace', traceEvent(consent));

  if (decision.decision === 'deny') {
    res.status(403).json({ error: { message: 'request denied by owner' } });
    return false;
  }
  return true;
}

interface ForwardSpec {
  kind: 'inference' | 'modify';
  original: Json;
  effective: Json;
}

async function forwardAndTrace(deps: GatewayDeps, agent: AgentRow, res: Response, spec: ForwardSpec): Promise<void> {
  let result: ComputeResult;
  try {
    result = await deps.queue.enqueue(agent.id, spec.effective);
  } catch (err) {
    console.error(`compute forward failed for agent ${agent.id}`, err);
    res.status(502).json({ error: { message: 'upstream error' } });
    return;
  }
  if (result.status >= 500 || result.status === 429) {
    // retries exhausted upstream — generic client error, detail server-side only
    console.error(`compute upstream degraded for agent ${agent.id}: status ${result.status}`);
    res.status(502).json({ error: { message: 'upstream error' } });
    return;
  }

  const rec: TraceRecord = await appendTrace(deps.pool, {
    agentId: agent.id,
    kind: spec.kind,
    originalRequest: spec.original,
    ...(spec.kind === 'modify' ? { effectiveRequest: spec.effective } : {}),
    response: result.body,
    ...(result.x0gTrace ? { x0gTrace: result.x0gTrace } : {}),
  });
  deps.hub.emit(agent.id, 'trace', traceEvent(rec));
  res.status(result.status).json(result.body);
}
