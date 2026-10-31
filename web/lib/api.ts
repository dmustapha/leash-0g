// File: web/lib/api.ts
// Typed client for the Phase-1 backend (spec §4). Every owner route sends the Privy access
// token as Bearer. The token getter is injected so components stay testable.

import { config } from './config';
import type {
  AgentDetail,
  AgentSummary,
  Alert,
  AlertClass,
  AlertKind,
  AlertStatus,
  ApprovalDecision,
  AuditBatch,
  Chain,
  ChainStep,
  CreateAgentRequest,
  CreateAgentResponse,
  Delegation,
  Digest,
  GatewayRule,
  Link,
  LinkMode,
  OwnerAuditBatch,
  OwnerRecord,
  OwnerRevokeFallback,
  OwnerSettingsPatch,
  OwnerSettingsView,
  RevokeBatchResult,
  TraceRecord,
  JobView,
  OwnerJobSpec,
  JobSpecSummary,
  ElevateRequest,
  ElevationDraft,
  DirectRequest,
  DirectionDraft,
  CallRule,
  CapabilityDecision,
  CapabilityEnvelopeView,
  CapabilityRuleAction,
  PresetKey,
  ResolvedPreset,
  AgentNetworksView,
  GasSurveyView,
  NetworkAccountView,
  NetworkChain,
  OnboardNetworkResult,
  SigningEnvelopeView,
  SigningRuleView,
  OnChainSigningGrantView,
} from './types';

export type TokenGetter = () => Promise<string | null>;

/** Machine-readable error body (Phase-2 spec §4): top-level string `error` code plus
 *  code-specific extras (retryAfter, limit, max, ownerRevokeFallback). */
type ErrorBody = {
  error?: { message?: string; reason?: string } | string;
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
      // SE-7 onboard refusals ship { error: { message, reason } } — the reason is the code.
      if (typeof body.error === 'object' && typeof body.error.reason === 'string') {
        this.code = body.error.reason;
      }
      if (typeof body.retryAfter === 'number') this.retryAfter = body.retryAfter;
      if (typeof body.limit === 'number') this.limit = body.limit;
      if (typeof body.max === 'number') this.max = body.max;
      if (body.ownerRevokeFallback) this.ownerRevokeFallback = body.ownerRevokeFallback;
    }
  }
}

async function request<T>(
  getToken: TokenGetter,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

    // — Phase 5 (create funnel) —
    // D-A2: the owner's saved job specs, for the requester job-handle picker.
    listJobSpecs: () => request<{ specs: JobSpecSummary[] }>(getToken, 'GET', '/api/job-specs'),
    // D-B1: spec-elevation — returns a QUARANTINED draft (writes nothing server-side).
    elevate: (body: ElevateRequest) =>
      request<{ draft: ElevationDraft }>(getToken, 'POST', '/api/create/elevate', body),
    streamUrl: (id: string) => `${config.apiUrl}/api/agents/${id}/stream`,

    // — Phase 5.5 (spec §9): conversational direction —
    // Re-direct a RUNNING agent: returns a QUARANTINED draft (writes nothing until confirm).
    direct: (id: string, body: DirectRequest) =>
      request<{ direction: { id: string; draft: DirectionDraft } }>(
        getToken,
        'POST',
        `/api/agents/${id}/direct`,
        body,
      ),
    // Confirm a direction: recipient (if any) is owner-typed, passed OUT-OF-BAND from the draft.
    // chainPlan (Phase 5.6) is the owner-authored chain — quarantined, arms no delegation.
    confirmDirection: (
      id: string,
      directionId: string,
      body: { edited: DirectionDraft; recipient?: string; chainPlan?: ChainStep[] },
    ) => request<{ ok: true }>(getToken, 'POST', `/api/agents/${id}/direct/${directionId}/confirm`, body),
    // Phase 5.6 chain read-model (owner-scoped, read-only, writes nothing).
    listChains: (cursor?: string) =>
      request<{ chains: Chain[]; nextCursor?: string }>(
        getToken,
        'GET',
        `/api/chains${cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    getChain: (id: string) =>
      request<{ chain: Chain; hops: Delegation[] }>(getToken, 'GET', `/api/chains/${id}`),
    // Ask the agent what it has done so far — the answer is quarantined agent-authored text.
    agentStatus: (id: string, q: string) =>
      request<{ answer: string; asOfSeq: number; quarantined: true }>(
        getToken,
        'GET',
        `/api/agents/${id}/status?q=${encodeURIComponent(q)}`,
      ),
    // Mark done / wind the agent down — stops it accepting new work.
    windDown: (id: string) => request<{ ok: true }>(getToken, 'POST', `/api/agents/${id}/wind-down`),

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

    // — Phase 3 (spec §4): alerts, owner stream, digest, settings, telegram —
    ownerStreamUrl: () => `${config.apiUrl}/api/owner/stream`,
    listAlerts: (filter?: {
      class?: AlertClass;
      kind?: AlertKind;
      agentId?: string;
      status?: AlertStatus;
      cursor?: string;
      limit?: number;
    }) => {
      const q = new URLSearchParams();
      if (filter?.class !== undefined) q.set('class', filter.class);
      if (filter?.kind !== undefined) q.set('kind', filter.kind);
      if (filter?.agentId !== undefined) q.set('agentId', filter.agentId);
      if (filter?.status !== undefined) q.set('status', filter.status);
      if (filter?.cursor !== undefined) q.set('cursor', filter.cursor);
      if (filter?.limit !== undefined) q.set('limit', String(filter.limit));
      const qs = q.toString();
      return request<{ alerts: Alert[]; unread: number; nextCursor?: string }>(
        getToken,
        'GET',
        `/api/alerts${qs ? `?${qs}` : ''}`,
      );
    },
    alertAction: (id: string, action: 'read' | 'dismiss') =>
      request<{ ok: true; alert: Alert }>(getToken, 'POST', `/api/alerts/${id}`, { action }),
    markAllAlertsRead: () =>
      request<{ ok: true; marked: number }>(getToken, 'POST', '/api/alerts/read-all'),
    getOwnerRecords: (cursor?: number) =>
      request<{ records: OwnerRecord[]; nextCursor: number | null; chainVerified: boolean }>(
        getToken,
        'GET',
        `/api/owner/records${cursor !== undefined ? `?cursor=${cursor}` : ''}`,
      ),
    getOwnerAudit: () => request<OwnerAuditBatch[]>(getToken, 'GET', '/api/owner/audit'),
    getDigest: () => request<{ digest: Digest }>(getToken, 'GET', '/api/digest'),
    markDigest: () =>
      request<{ ok: true; digest: Digest }>(getToken, 'POST', '/api/digest/mark'),
    getOwnerSettings: () => request<OwnerSettingsView>(getToken, 'GET', '/api/owner/settings'),
    patchOwnerSettings: (patch: OwnerSettingsPatch) =>
      request<{ ok: true } & Omit<OwnerSettingsView, 'telegramLinkedAt'>>(
        getToken,
        'PATCH',
        '/api/owner/settings',
        patch,
      ),
    telegramLink: () =>
      request<{ url: string; expiresAt: string }>(getToken, 'POST', '/api/owner/telegram/link'),
    telegramUnlink: () => request<{ ok: true }>(getToken, 'DELETE', '/api/owner/telegram'),
    telegramPing: () => request<{ ok: true }>(getToken, 'POST', '/api/owner/telegram/ping'),

    // — Phase 4 (spec §7): ACP jobs (request → deliver → verify → settle) —
    listJobs: () => request<{ jobs: JobView[] }>(getToken, 'GET', '/api/jobs'),
    getJob: (id: string) => request<JobView>(getToken, 'GET', `/api/jobs/${id}`),
    putJobSpec: (ref: string, body: OwnerJobSpec) =>
      request<{ ok: true; sourceRef: string }>(getToken, 'PUT', `/api/job-specs/${encodeURIComponent(ref)}`, body),
    getJobSpec: (ref: string) =>
      request<OwnerJobSpec>(getToken, 'GET', `/api/job-specs/${encodeURIComponent(ref)}`),

    // — Stage D (spec §7): governed-calldata capability grants —
    // Preview a preset's resolved rules BEFORE signing (no txHash → recorded:false).
    resolvePreset: (agentId: string, presetKey: PresetKey) =>
      request<{ ok: true; preset: ResolvedPreset; recorded: false }>(
        getToken,
        'POST',
        `/api/agents/${agentId}/capabilities/preset`,
        { presetKey },
      ),
    // Record the applied preset read-model AFTER the owner signed (carries the txHash).
    recordPreset: (agentId: string, presetKey: PresetKey, txHash: string) =>
      request<{ ok: true; preset: ResolvedPreset; recorded: boolean }>(
        getToken,
        'POST',
        `/api/agents/${agentId}/capabilities/preset`,
        { presetKey, txHash },
      ),
    // Propose (loosen, timelocked) / tighten (instant) / remove (instant) a custom rule.
    capabilityRule: (
      agentId: string,
      body: { action: CapabilityRuleAction; rule: CallRule; txHash?: string },
    ) =>
      request<{ ok: true; action: CapabilityRuleAction; rule?: CallRule; recorded?: boolean }>(
        getToken,
        'POST',
        `/api/agents/${agentId}/capabilities/rule`,
        body,
      ),
    // Read-only capability envelope: standing grants + applied presets + recent JIT decisions.
    listCapabilities: (agentId: string) =>
      request<CapabilityEnvelopeView>(getToken, 'GET', `/api/agents/${agentId}/capabilities`),
    // Decide a JIT capability request. approve_once/always_allow require an owner-signed tx;
    // always_allow also carries the rule the owner confirmed. deny sends no tx.
    decideCapability: (
      approvalId: string,
      body: { decision: CapabilityDecision; txHash?: string; rule?: CallRule },
    ) =>
      request<{ ok: true; request: { id: string; status: string } }>(
        getToken,
        'POST',
        `/api/approvals/${approvalId}`,
        body,
      ),

    // — RH2 B2 (TA-ABI-5 close): governed-signing grants (V5 accounts) —
    // Read-only signing envelope: reviewed descriptors + standing grants (read-model mirror).
    listSigning: (agentId: string) =>
      request<SigningEnvelopeView>(getToken, 'GET', `/api/agents/${agentId}/signing`),
    // Record the read-model mirror AFTER the owner signed the on-chain grant (set), or remove a
    // descriptor's grant (the owner's on-chain removeSigningDescriptor bumps the epoch). The
    // response carries the backend-computed `onChainGrant` params (re-derivable, idempotent).
    signingRule: (
      agentId: string,
      body: {
        action: 'set' | 'remove';
        rule: {
          descriptorId: number;
          spenderSet: string[];
          perIntentCap: string;
          maxDeadlineWindow: number;
          token: string;
          tokenCaps?: { token: string; cap: string }[];
        };
      },
    ) =>
      request<{ ok: true; action: 'set' | 'remove'; rule?: SigningRuleView; onChainGrant?: OnChainSigningGrantView }>(
        getToken,
        'POST',
        `/api/agents/${agentId}/signing/rule`,
        body,
      ),

    // — Stage E / SE-7 (spec §7.C): multichain networks —
    // NOTE: distinct from listChains above — /api/networks is the BLOCKCHAIN network table;
    // /api/chains is the agent-chaining (delegation graph) surface.
    listNetworks: () => request<{ chains: NetworkChain[] }>(getToken, 'GET', '/api/networks'),
    // The agent's per-chain presence: home chain + onboarded chains, one address everywhere.
    getAgentNetworks: (agentId: string) =>
      request<AgentNetworksView>(getToken, 'GET', `/api/agents/${agentId}/networks`),
    // AQ-FND M-3: owner opt-in for the relayer gas bootstrap (default off) + the read-only survey.
    setGasPolicy: (agentId: string, allowRelayerBootstrap: boolean) =>
      request<{ ok: true; allowRelayerBootstrap: boolean }>(getToken, 'PATCH', `/api/agents/${agentId}/gas-policy`, {
        allowRelayerBootstrap,
      }),
    getGasSurvey: (agentId: string) =>
      request<GasSurveyView>(getToken, 'GET', `/api/agents/${agentId}/gas-survey`),
    // Onboard the agent's account onto another registered network (byte-exact tuple replay).
    // 409 refusals carry a typed reason in ApiError.code (see OnboardRefusalReason).
    onboardNetwork: (agentId: string, chainId: number) =>
      request<OnboardNetworkResult>(getToken, 'POST', `/api/agents/${agentId}/networks`, {
        chainId,
      }),
    // Owner-scoped view of one account on one chain.
    getNetworkAccount: (chainId: number, accountAddr: string) =>
      request<NetworkAccountView>(
        getToken,
        'GET',
        `/api/networks/${chainId}/accounts/${accountAddr}`,
      ),
  };
}

export type Api = ReturnType<typeof makeApi>;
