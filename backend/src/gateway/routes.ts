import { Router, json, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { ComputeQueue, ComputeResult } from './compute-queue.js';
import { authenticateAgent } from './agent-auth.js';
import { evaluateRules } from './interceptor.js';
import { appendTrace } from '../trace/trace-store.js';
import { createApproval, expireApproval } from '../store/approvals.js';
import type { ApprovalBroker } from '../approvals/broker.js';
import type { AlertService } from '../alerts/service.js';
import { inMinutes } from '../util/format.js';
import { awaitApprovalDecision } from '../approvals/rendezvous.js';
import type { SseHub } from '../sse/hub.js';
import { approvalEvent, requestSummary, traceEvent } from '../sse/events.js';
import type { Json } from '../crypto/canonical.js';
import type { AgentRow, TraceRecord } from '../types.js';
import { detectProtocol } from './protocols/detect.js';
import { anthropicToOpenAI, openAIToAnthropic, anthropicError } from './protocols/anthropic.js';
import { handleMcpRequest } from './mcp/transport.js';
import { denyAllProvider, type McpToolProvider } from './mcp/provider.js';

export interface GatewayDeps {
  pool: Pool;
  queue: ComputeQueue;
  hub: SseHub;
  broker: ApprovalBroker;
  approvalTimeoutMs: number;
  /** Phase-3 alert engine — approval_required emission + expiry resolve. */
  alerts: AlertService;
  /**
   * SF-1 (BR-F2): the MCP tool-provider. Defaults to `denyAllProvider`
   * (default-deny, no tool policy in SF-1); SF-3 injects the governed provider.
   */
  mcpProvider?: McpToolProvider | undefined;
}

const BODY_LIMIT = 256 * 1024; // 256KB JSON cap (M-01)

/**
 * SF-1: per-protocol response/error shaping. The governed core runs on the
 * OpenAI body for EVERY protocol (interception parity, F-1a); the shaper maps
 * the successful OpenAI response and the error bodies back to the caller's
 * protocol. The `protocol` tag rides the trace detail (per-protocol presence,
 * F-Xd). `openai` shapers are identity — the legacy route is untouched.
 */
interface ProtocolShaper {
  protocol: 'openai' | 'anthropic';
  shapeResponse(openaiBody: Json): Json;
  shapeError(status: number, message: string): Json;
}

const openaiShaper: ProtocolShaper = {
  protocol: 'openai',
  shapeResponse: (b) => b,
  shapeError: (_status, message) => ({ error: { message } }),
};

function anthropicShaper(reqModel: string): ProtocolShaper {
  return {
    protocol: 'anthropic',
    shapeResponse: (b) => openAIToAnthropic(b, reqModel),
    shapeError: (status, message) => anthropicError(status, message),
  };
}

/**
 * The gateway: a multi-protocol reverse proxy to the 0G-Compute OpenAI backend
 * with the interception pipeline (observe | block | modify | require-approval).
 * Exact-path/exact-shape routing (F-1c): POST /v1/chat/completions (OpenAI,
 * unchanged), POST /v1/messages (Anthropic-native adapter, SF-1), POST /mcp
 * (MCP transport, SF-1) — and nothing else. An unknown shape is refused.
 */
export function gatewayRouter(deps: GatewayDeps): Router {
  const router = Router();
  const mcpProvider = deps.mcpProvider ?? denyAllProvider;

  router.post('/v1/chat/completions', json({ limit: BODY_LIMIT }), (req, res) => {
    handleOpenAI(deps, req, res).catch((err: unknown) => failClosed(res, err, openaiShaper));
  });

  router.post('/v1/messages', json({ limit: BODY_LIMIT }), (req, res) => {
    handleAnthropic(deps, req, res).catch((err: unknown) =>
      failClosed(res, err, anthropicShaper(readModel(req.body))),
    );
  });

  router.post('/mcp', json({ limit: BODY_LIMIT }), (req, res) => {
    handleMcp(deps, mcpProvider, req, res).catch((err: unknown) => {
      console.error('gateway mcp error', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
    });
  });

  return router;
}

function failClosed(res: Response, err: unknown, shaper: ProtocolShaper): void {
  console.error('gateway error', err);
  if (!res.headersSent) res.status(502).json(shaper.shapeError(502, 'upstream error'));
}

function readModel(body: unknown): string {
  return body && typeof body === 'object' && typeof (body as { model?: unknown }).model === 'string'
    ? (body as { model: string }).model
    : 'unknown';
}

/** OpenAI route (legacy, unchanged behaviour): forward the body as the governed shape. */
async function handleOpenAI(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  if (detectProtocol('/v1/chat/completions', req.body as Json) !== 'openai') {
    res.status(400).json(openaiShaper.shapeError(400, 'unrecognized request shape'));
    return;
  }
  const auth = await authenticateAgent(deps.pool, req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.status).json(openaiShaper.shapeError(auth.status, auth.status === 401 ? 'unauthorized' : 'forbidden'));
    return;
  }
  await runGoverned(deps, auth.agent, res, req.body as Json, openaiShaper);
}

/**
 * Anthropic route (SF-1, F-1a): exact-shape gate → map to OpenAI → run the SAME
 * governed core → map the response back to Anthropic. Streaming is refused
 * (honest caveat, `00 §5b`): intervention on a stream is documented-weaker and
 * v1 does not translate Anthropic's event-framed SSE.
 */
async function handleAnthropic(deps: GatewayDeps, req: Request, res: Response): Promise<void> {
  const body = req.body as Json;
  if (detectProtocol('/v1/messages', body) !== 'anthropic') {
    res.status(400).json(anthropicError(400, 'unrecognized request shape'));
    return;
  }
  // C-SF1-2: authenticate BEFORE protocol-adaptation. An unauthenticated or
  // revoked caller is refused before the adapter does any work on its body —
  // the adapter never runs on an unauthorized request.
  const auth = await authenticateAgent(deps.pool, req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.status).json(anthropicError(auth.status, auth.status === 401 ? 'unauthorized' : 'forbidden'));
    return;
  }
  const obj = body as Record<string, Json>;
  if (obj['stream'] === true) {
    res.status(400).json(anthropicError(400, 'streaming is not supported on this gateway (v1)'));
    return;
  }
  const adapted = anthropicToOpenAI(obj);
  if (!adapted.ok) {
    res.status(400).json(anthropicError(400, `request could not be adapted: ${adapted.reason}`));
    return;
  }
  await runGoverned(deps, auth.agent, res, adapted.openai, anthropicShaper(obj['model'] as string));
}

async function handleMcp(
  deps: GatewayDeps,
  provider: McpToolProvider,
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await authenticateAgent(deps.pool, req.headers.authorization);
  if (!auth.ok) {
    res.status(auth.status).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: auth.status === 401 ? 'unauthorized' : 'forbidden' } });
    return;
  }
  // Exact-shape gate via the shared detector (consistency with the other two
  // routes — the fail-closed contract lives in one place, detect.ts).
  if (detectProtocol('/mcp', req.body as Json) !== 'mcp') {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC request' } });
    return;
  }
  const result = await handleMcpRequest(provider, auth.agent, req.body as Json);
  if (result.body === null) {
    res.status(result.status).end();
    return;
  }
  res.status(result.status).json(result.body);
}

/**
 * The shared governed core (F-1a parity): authenticate, evaluate rules on the
 * OpenAI body, and apply observe/block/modify/require_approval IDENTICALLY for
 * every protocol. The only per-protocol variation is the response/error shape
 * and the `protocol` trace tag.
 */
async function runGoverned(
  deps: GatewayDeps,
  agent: AgentRow,
  res: Response,
  body: Json,
  shaper: ProtocolShaper,
): Promise<void> {
  const outcome = evaluateRules(agent.gatewayRules, body);

  // C-5: non-text parts can't be scanned by rules — record their presence on
  // every trace this request produces rather than silently ignoring them. SF-1:
  // the protocol tag rides every trace this request produces (per-protocol
  // presence, F-Xd) — omitted for the legacy OpenAI path (no behaviour change).
  const protocolDetail = shaper.protocol === 'anthropic' ? { protocol: shaper.protocol } : {};
  const nonText = {
    ...(outcome.nonTextPartTypes.length > 0 ? { nonTextPartTypes: outcome.nonTextPartTypes } : {}),
    ...protocolDetail,
  };

  if (outcome.action === 'block') {
    const rec = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'block',
      originalRequest: body,
      detail: {
        rule: outcome.rule.match,
        ...('escalated' in outcome && outcome.escalated ? { escalated: outcome.escalated } : {}),
        ...nonText,
      },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(rec));
    res.status(403).json(shaper.shapeError(403, 'request blocked by policy'));
    return;
  }

  if (outcome.action === 'require_approval') {
    const approved = await holdForApproval(deps, agent, body, res, shaper, outcome.rule.match);
    if (!approved) return; // response already sent (deny/timeout)
    await forwardAndTrace(deps, agent, res, shaper, { kind: 'inference', original: body, effective: body, detail: nonText });
    return;
  }

  if (outcome.action === 'modify') {
    await forwardAndTrace(deps, agent, res, shaper, { kind: 'modify', original: body, effective: outcome.effective, detail: nonText });
    return;
  }

  await forwardAndTrace(deps, agent, res, shaper, { kind: 'inference', original: body, effective: body, detail: nonText });
}

/**
 * Hold the request for the owner. Returns true only after the approve consent
 * record is DURABLY persisted — POST /api/approvals/:id appends the consent
 * record BEFORE notifying the broker, so waking here implies consent is
 * already durable (spec: consent strictly before forward). This path appends
 * NO consent record itself (single-append semantics); only the timeout path
 * writes, transitioning the row pending → expired chain-visibly.
 */
async function holdForApproval(
  deps: GatewayDeps,
  agent: AgentRow,
  body: Json,
  res: Response,
  shaper: ProtocolShaper,
  matchedRule: string,
): Promise<boolean> {
  const approval = await createApproval(deps.pool, agent.id, body);
  deps.hub.emit(agent.id, 'approval', approvalEvent({ approvalId: approval.id, summary: requestSummary(body) }));
  // Daily loop (spec §3b): the decision alert — actionable inline on both
  // channels; auto-resolves when decided anywhere. Emission never blocks the
  // hold (AlertService.emit swallows its own failures).
  // M-01 (security gate): the ALERT summary is composed from STRUCTURED,
  // server-side facts only — the request tail is agent-authored
  // (attacker-influenceable under prompt injection) and must not ride
  // Telegram (00 §6b). The matched rule text is OWNER-authored (safe); the
  // full request stays visible on the cockpit approval card.
  await deps.alerts.emit(agent.ownerAddr, {
    agentId: agent.id,
    class: 'decision',
    kind: 'approval_required',
    summary:
      `${agent.name} paused a request because your "${matchedRule}" rule requires approval. ` +
      `Full request is in the app. ⏱ Auto-denies ${inMinutes(deps.approvalTimeoutMs)} if you don't answer.`,
    refs: { approvalId: approval.id, autoDeniesAtUnix: Math.floor((Date.now() + deps.approvalTimeoutMs) / 1000) },
  });
  // C-3: shared register→check-durable→wait→recheck rendezvous — closes the
  // approve-recorded-but-never-forwarded race (decision landing durably
  // between createApproval and the wait registration).
  const decision = await awaitApprovalDecision({ pool: deps.pool, broker: deps.broker }, approval.id, deps.approvalTimeoutMs);

  if (decision === 'timeout') {
    // Terminal state + consent-class record: timeouts are never silent.
    const expired = await expireApproval(deps.pool, approval.id);
    if (expired) {
      const consent = await appendTrace(deps.pool, {
        agentId: agent.id,
        kind: 'consent',
        approvalId: approval.id,
        decision: 'expired',
        decidedBy: 'system',
        originalRequest: body,
        detail: { reason: 'approval timed out' },
      });
      deps.hub.emit(agent.id, 'trace', traceEvent(consent));
      await deps.alerts.resolveByApproval(approval.id, {
        resolution: 'expired',
        via: 'system',
        agentId: agent.id,
        consentSeq: consent.seq,
      });
    }
    res.status(408).json(shaper.shapeError(408, 'approval timed out'));
    return false;
  }

  if (decision.decision === 'deny') {
    res.status(403).json(shaper.shapeError(403, 'request denied by owner'));
    return false;
  }
  return true;
}

interface ForwardSpec {
  kind: 'inference' | 'modify';
  original: Json;
  effective: Json;
  /** Extra trace detail (e.g. C-5 nonTextPartTypes); empty object = omitted. */
  detail?: Record<string, Json>;
}

async function forwardAndTrace(
  deps: GatewayDeps,
  agent: AgentRow,
  res: Response,
  shaper: ProtocolShaper,
  spec: ForwardSpec,
): Promise<void> {
  let result: ComputeResult;
  try {
    result = await deps.queue.enqueue(agent.id, spec.effective);
  } catch (err) {
    console.error(`compute forward failed for agent ${agent.id}`, err);
    // Failed forwards are chain-visible: trace + SSE BEFORE responding.
    await traceForwardFailure(deps, agent, spec.original, { reason: 'compute forward failed' });
    res.status(502).json(shaper.shapeError(502, 'upstream error'));
    return;
  }
  if (result.status >= 500 || result.status === 429) {
    // retries exhausted upstream — generic client error, detail server-side only
    console.error(`compute upstream degraded for agent ${agent.id}: status ${result.status}`);
    await traceForwardFailure(deps, agent, spec.original, {
      reason: 'upstream degraded after retries',
      upstreamStatus: result.status,
    });
    res.status(502).json(shaper.shapeError(502, 'upstream error'));
    return;
  }

  const rec: TraceRecord = await appendTrace(deps.pool, {
    agentId: agent.id,
    kind: spec.kind,
    originalRequest: spec.original,
    ...(spec.kind === 'modify' ? { effectiveRequest: spec.effective } : {}),
    response: result.body,
    ...(result.x0gTrace ? { x0gTrace: result.x0gTrace } : {}),
    ...(spec.detail && Object.keys(spec.detail).length > 0 ? { detail: spec.detail } : {}),
  });
  deps.hub.emit(agent.id, 'trace', traceEvent(rec));
  res.status(result.status).json(shaper.shapeResponse(result.body));
}

async function traceForwardFailure(
  deps: GatewayDeps,
  agent: AgentRow,
  original: Json,
  detail: { reason: string; upstreamStatus?: number },
): Promise<void> {
  const rec = await appendTrace(deps.pool, {
    agentId: agent.id,
    kind: 'error',
    originalRequest: original,
    detail: { status: 502, ...detail },
  });
  deps.hub.emit(agent.id, 'trace', traceEvent(rec));
}
