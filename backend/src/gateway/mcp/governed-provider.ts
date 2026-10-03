import type { Pool } from 'pg';
import type { Json } from '../../crypto/canonical.js';
import type { SseHub } from '../../sse/hub.js';
import type { ApprovalBroker } from '../../approvals/broker.js';
import type { AlertService } from '../../alerts/service.js';
import { getAgentById } from '../../store/agents.js';
import { expireApproval } from '../../store/approvals.js';
import { awaitApprovalDecision } from '../../approvals/rendezvous.js';
import { appendTrace } from '../../trace/trace-store.js';
import { traceEvent } from '../../sse/events.js';
import {
  defaultToolRegistry,
  guardToolResult,
  resolveEgressEndpoint,
  type ToolGrantState,
  type ToolRegistry,
} from '../../tool-use/index.js';
import { gateToolCall, type ToolGateResult } from './tool-gate.js';
import { raiseToolRequest, type ToolServiceDeps } from '../../tool-use/tool-service.js';
import { listToolRules, setToolRequestDecision } from '../../store/tools.js';
import {
  McpToolForbidden,
  type McpCallResult,
  type McpTenantContext,
  type McpToolDescriptor,
  type McpToolProvider,
} from './provider.js';

/**
 * SF-3 — the GOVERNED MCP tool-provider. Replaces `denyAllProvider` via the
 * one-line `deps.mcpProvider` swap (the SF-1 seam, NO transport change). It is
 * the enforcement point on the MCP `tools/call` path:
 *
 *   classify (tool-gate, grant-state only) →
 *     forbidden  → refuse (default-deny, McpToolForbidden);
 *     L1         → forward to the ALLOWLISTED external MCP endpoint (egress proxy),
 *                  I/O-guarding the RESULT before it returns to the model;
 *     L2         → raise a JIT request on the EXISTING approval rail and HOLD the
 *                  call synchronously (mirror of the inference `holdForApproval`)
 *                  until the owner decides approve-once / always-allow / deny, then
 *                  forward or refuse. A sensitive tool ALWAYS takes this path
 *                  regardless of what the model decided (00 §6c).
 *
 * The proxy forwards ONLY to the owner-configured, allowlisted endpoint resolved
 * from grant-state — never a model-supplied URL (SSRF/egress guard, §8). A tool
 * RESULT can never widen the allowlist (classification reads grant-state only).
 */

/** The egress leg: forward one governed tool call to the real external MCP server. */
export interface McpEgressClient {
  call(endpoint: string, toolName: string, args: Json): Promise<McpCallResult>;
}

export interface GovernedProviderDeps {
  pool: Pool;
  hub: SseHub;
  broker: ApprovalBroker;
  alerts: AlertService;
  /** synchronous JIT hold timeout (ms) — the held tool call auto-denies after this. */
  approvalTimeoutMs: number;
  /** JIT card TTL surfaced to the owner (ms). */
  jitTtlMs: number;
  registry?: ToolRegistry;
  egress: McpEgressClient;
  /** loads the owner tool grant-state (rules + egress allowlist + endpoints) for an agent. */
  loadGrant: (agentId: string) => Promise<ToolGrantState>;
  maxIoBytes?: number;
}

export function createGovernedMcpProvider(deps: GovernedProviderDeps): McpToolProvider {
  const registry = deps.registry ?? defaultToolRegistry;
  const serviceDeps: ToolServiceDeps = {
    pool: deps.pool,
    hub: deps.hub,
    broker: deps.broker,
    alerts: deps.alerts,
    registry,
    jitTtlMs: deps.jitTtlMs,
  };

  async function forward(gate: ToolGateResult): Promise<McpCallResult> {
    // Defence-in-depth: classify already forbade a missing/off-allowlist endpoint,
    // so a non-forbidden call always has one. Re-check fail-closed.
    if (!gate.endpoint || !gate.descriptor) throw new McpToolForbidden(gate.toolId);
    const result = await deps.egress.call(gate.endpoint, gate.descriptor.name, gate.guardedArgs);
    // Guard the RESULT before it reaches the model (prompt-injection-via-result,
    // exfiltration, proto-pollution, F-3b). A rejected result is neutralized to an
    // error block — never surfaced raw.
    const guarded = guardToolResult(result.content ?? [], deps.maxIoBytes);
    if (!guarded.ok) {
      return {
        content: [{ type: 'text', text: '[tool result rejected by LEASH I/O guard]' }],
        isError: true,
      };
    }
    const content = Array.isArray(guarded.value) ? guarded.value : [guarded.value];
    return { content, ...(result.isError ? { isError: true } : {}) };
  }

  return {
    async listTools(ctx: McpTenantContext): Promise<McpToolDescriptor[]> {
      const grant = await deps.loadGrant(ctx.agentId);
      const out: McpToolDescriptor[] = [];
      for (const [toolId, rule] of grant.rules) {
        if (!rule.allowed) continue;
        const d = registry.get(toolId);
        if (!d) continue; // never expose a tool the registry doesn't know
        // Only expose tools whose egress endpoint is actually allowlisted — a tool
        // the proxy could never forward is not offered (honest tool-list). Shares
        // the SAME resolver `classifyTool` uses, so list + call can never disagree.
        if (resolveEgressEndpoint(d, grant) === null) continue;
        out.push({
          name: d.toolId,
          ...(d.description ? { description: d.description } : {}),
          inputSchema: { type: 'object' },
        });
      }
      return out;
    },

    async callTool(ctx: McpTenantContext, name: string, args: Json): Promise<McpCallResult> {
      const grant = await deps.loadGrant(ctx.agentId);
      const gate = gateToolCall(name, args, registry, grant, deps.maxIoBytes);

      if (gate.classification.lane === 'forbidden') {
        // Default-deny + fail-closed (unknown/not-allowlisted/egress/io-rejected).
        throw new McpToolForbidden(name);
      }

      if (gate.classification.lane === 'l1') {
        return forward(gate);
      }

      // L2 → synchronous JIT hold on the existing approval rail. The agent is
      // read once here; `raiseToolRequest` binds the call hash with its chainId.
      // This is a deliberately independent read from `loadGrant` above — the hash
      // is for JIT idempotency only (never an authority input), so a narrow
      // agent-mutation race between the two cannot widen authority (fail-closed:
      // a missing agent forbids).
      const agent = await getAgentById(deps.pool, ctx.agentId);
      if (!agent) throw new McpToolForbidden(name);
      const { request } = await raiseToolRequest(serviceDeps, agent, gate);
      const approvalId = request.approvalId;
      if (!approvalId) throw new McpToolForbidden(name);

      const decision = await awaitApprovalDecision(
        { pool: deps.pool, broker: deps.broker },
        approvalId,
        deps.approvalTimeoutMs,
      );

      if (decision === 'timeout') {
        // Terminal + consent-class record: a timed-out tool JIT is never silent.
        const expired = await expireApproval(deps.pool, approvalId);
        if (expired) {
          await setToolRequestDecision(deps.pool, request.id, 'expired');
          const consent = await appendTrace(deps.pool, {
            agentId: agent.id,
            kind: 'consent',
            approvalId,
            decision: 'expired',
            decidedBy: 'system',
            originalRequest: request.decoded,
            detail: { reason: 'tool approval timed out', toolId: request.toolId },
          });
          deps.hub.emit(agent.id, 'trace', traceEvent(consent));
          await deps.alerts.resolveByApproval(approvalId, {
            resolution: 'expired',
            via: 'system',
            agentId: agent.id,
            consentSeq: consent.seq,
          });
        }
        throw new McpToolForbidden(name);
      }

      if (decision.decision === 'deny') throw new McpToolForbidden(name);

      // Approved (approve-once or always-allow) — consent is durable (appended by
      // decideToolRequest before the broker notify) → forward is safe.
      return forward(gate);
    },
  };
}

// ---------------------------------------------------------------------------
// Default DB-backed grant loader.
// ---------------------------------------------------------------------------

/**
 * Owner-configured egress policy (SSRF guard). `serverEndpoints` maps a logical
 * server key → its external MCP endpoint; `egressAllowlist` is the set of origins
 * the proxy may forward to. Both are LEASH/owner config — never model-supplied.
 */
export interface EgressConfig {
  serverEndpoints: Record<string, string>;
  egressAllowlist: string[];
}

/**
 * Build a grant loader that reads the per-agent `tool_rules` read-model and
 * layers the owner-configured egress policy (static config). The tool rules are
 * per-tenant (keyed by the authenticated agent, derived from the token — never
 * client-supplied), so one tenant can never see or call another's tools.
 */
export function createDbGrantLoader(
  pool: Pool,
  egress: EgressConfig,
): (agentId: string) => Promise<ToolGrantState> {
  const egressAllowlist = new Set(egress.egressAllowlist.map((o) => o.toLowerCase()));
  const serverEndpoints = new Map(Object.entries(egress.serverEndpoints));
  return async (agentId: string): Promise<ToolGrantState> => {
    const rules = await listToolRules(pool, agentId);
    return {
      rules: new Map(
        rules
          .filter((r) => r.status !== 'removed')
          .map((r) => [
            r.toolId.toLowerCase(),
            {
              toolId: r.toolId.toLowerCase(),
              allowed: r.allowed,
              sensitive: r.sensitive,
              ...(r.perCallPolicy ? { perCallPolicy: r.perCallPolicy } : {}),
            },
          ]),
      ),
      egressAllowlist,
      serverEndpoints,
    };
  };
}
