// File: web/lib/api.ts
// Typed client for the Phase-1 backend (spec §4). Every owner route sends the Privy access
// token as Bearer. The token getter is injected so components stay testable.

import { config } from './config';
import type {
  AgentDetail,
  AgentSummary,
  ApprovalDecision,
  AuditBatch,
  CreateAgentRequest,
  CreateAgentResponse,
  Delegation,
  GatewayRule,
  Link,
  LinkMode,
  OwnerRevokeFallback,
  RevokeBatchResult,
  TraceRecord,
} from './types';

export type TokenGetter = () => Promise<string | null>;

/** Machine-readable error body (Phase-2 spec §4): top-level string `error` code plus
 *  code-specific extras (retryAfter, limit, max, ownerRevokeFallback). */
type ErrorBody = {
  error?: { message?: string } | string;
  message?: string;
  retryAfter?: number;
  limit?: number;
  max?: number;
  ownerRevokeFallback?: OwnerRevokeFallback;
};

export class ApiError extends Error {
  /** Machine code when the backend sent one (e.g. 'rate_limited', 'guardian_revoke_failed'). */
  public code?: string;
  public retryAfter?: number;
  public limit?: number;
  public max?: number;
  public ownerRevokeFallback?: OwnerRevokeFallback;

  constructor(
    public status: number,
    message: string,
    body?: ErrorBody,
  ) {
    super(message);
    this.name = 'ApiError';
    if (body) {
      if (typeof body.error === 'string') this.code = body.error;
      if (typeof body.retryAfter === 'number') this.retryAfter = body.retryAfter;
      if (typeof body.limit === 'number') this.limit = body.limit;
      if (typeof body.max === 'number') this.max = body.max;
      if (body.ownerRevokeFallback) this.ownerRevokeFallback = body.ownerRevokeFallback;
    }
  }
}

async function request<T>(
  getToken: TokenGetter,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let parsed: ErrorBody | undefined;
    try {
      // Backend errors are shaped { error: { message } } (owner-routes); tolerate a plain
      // string error or top-level message too. Never stringify an object into the UI.
      const j = (await res.json()) as ErrorBody;
      parsed = j;
      const fromError = typeof j.error === 'string' ? j.error : j.error?.message;
      detail = fromError ?? j.message ?? detail;
    } catch {
      /* generic error body */
    }
    throw new ApiError(res.status, detail, parsed);
  }
  return (await res.json()) as T;
}

export function makeApi(getToken: TokenGetter) {
  return {
    createAgent: (req: CreateAgentRequest) =>
      request<CreateAgentResponse>(getToken, 'POST', '/api/agents', req),
    getAgent: (id: string) => request<AgentDetail>(getToken, 'GET', `/api/agents/${id}`),
    getTraces: (id: string, cursor?: number) =>
      request<{ records: TraceRecord[]; nextCursor: number | null; chainVerified: boolean }>(
        getToken,
        'GET',
        `/api/agents/${id}/traces${cursor !== undefined ? `?cursor=${cursor}` : ''}`,
      ),
    decideApproval: (approvalId: string, decision: ApprovalDecision) =>
      request<{ ok: true }>(getToken, 'POST', `/api/approvals/${approvalId}`, decision),
    revoke: (id: string) => request<{ ok: true; txHash?: string }>(getToken, 'POST', `/api/agents/${id}/revoke`),
    start: (id: string) => request<{ ok: true }>(getToken, 'POST', `/api/agents/${id}/start`),
    stop: (id: string) => request<{ ok: true }>(getToken, 'POST', `/api/agents/${id}/stop`),
    rotate: (id: string) =>
      request<{ gatewayToken: string }>(getToken, 'POST', `/api/agents/${id}/rotate`),
    getAudit: (id: string) => request<AuditBatch[]>(getToken, 'GET', `/api/agents/${id}/audit`),
    streamUrl: (id: string) => `${config.apiUrl}/api/agents/${id}/stream`,

    // — Phase 2 (spec §4) —
    listAgents: (cursor?: string) =>
      request<{ agents: AgentSummary[]; nextCursor?: string }>(
        getToken,
        'GET',
        `/api/agents${cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    patchRules: (id: string, rules: GatewayRule[]) =>
      request<{ ok: true; rules: GatewayRule[] }>(getToken, 'PATCH', `/api/agents/${id}/rules`, {
        rules,
      }),
    createLink: (body: { fromAgentId: string; toAgentId: string; mode: LinkMode }) =>
      request<{ link: Link }>(getToken, 'POST', '/api/links', body),
    listLinks: () => request<{ links: Link[] }>(getToken, 'GET', '/api/links'),
    updateLink: (id: string, body: { action: 'pause' | 'resume' | 'remove' } | { mode: LinkMode }) =>
      request<{ link: Link }>(getToken, 'POST', `/api/links/${id}`, body),
    listDelegations: (filter: { agentId?: string; linkId?: string; cursor?: string }) => {
      const q = new URLSearchParams();
      if (filter.agentId !== undefined) q.set('agentId', filter.agentId);
      if (filter.linkId !== undefined) q.set('linkId', filter.linkId);
      if (filter.cursor !== undefined) q.set('cursor', filter.cursor);
      return request<{ delegations: Delegation[]; nextCursor?: string }>(
        getToken,
        'GET',
        `/api/delegations?${q.toString()}`,
      );
    },
    revokeBatch: (agentIds: string[]) =>
      request<{ results: RevokeBatchResult[] }>(getToken, 'POST', '/api/agents/revoke-batch', {
        agentIds,
      }),
  };
}

export type Api = ReturnType<typeof makeApi>;
