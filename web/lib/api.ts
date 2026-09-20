// File: web/lib/api.ts
// Typed client for the Phase-1 backend (spec §4). Every owner route sends the Privy access
// token as Bearer. The token getter is injected so components stay testable.

import { config } from './config';
import type {
  AgentDetail,
  ApprovalDecision,
  AuditBatch,
  CreateAgentRequest,
  CreateAgentResponse,
  TraceRecord,
} from './types';

export type TokenGetter = () => Promise<string | null>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  getToken: TokenGetter,
  method: 'GET' | 'POST',
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
    try {
      // Backend errors are shaped { error: { message } } (owner-routes); tolerate a plain
      // string error or top-level message too. Never stringify an object into the UI.
      const j = (await res.json()) as { error?: { message?: string } | string; message?: string };
      const fromError = typeof j.error === 'string' ? j.error : j.error?.message;
      detail = fromError ?? j.message ?? detail;
    } catch {
      /* generic error body */
    }
    throw new ApiError(res.status, detail);
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
  };
}

export type Api = ReturnType<typeof makeApi>;
