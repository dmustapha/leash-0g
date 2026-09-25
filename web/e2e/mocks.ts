// File: web/e2e/mocks.ts
// Route-mocked backend for Playwright (Phase 1 + Phase 2 coordination routes). Same-origin
// under /mock-api (see playwright.config.ts NEXT_PUBLIC_API_URL) so no CORS. Stateful per test.
import type { Page, Route } from '@playwright/test';

export type MockAgent = {
  agentId: string;
  name: string;
  status: 'active' | 'revoked';
  accountAddr: string;
  sessionKeyAddr: string;
  accountBalanceWei: string;
  createdAt: string;
};

export type MockLink = {
  id: string;
  ownerAddr: string;
  fromAgentId: string;
  toAgentId: string;
  mode: 'auto' | 'supervised';
  status: 'active' | 'paused' | 'removed';
  createdAt: string;
  delegationCount: number;
};

export type MockDelegation = {
  id: string;
  linkId: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  payload: unknown;
  status: string;
  result?: unknown;
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
};

export type MockAlert = {
  id: string;
  ownerAddr: string;
  agentId?: string;
  linkId?: string;
  class: 'decision' | 'info';
  kind: string;
  status: 'unread' | 'read' | 'resolved' | 'dismissed';
  summary: string;
  refs: Record<string, unknown>;
  count: number;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
  resolvedVia?: string;
};

export type MockOwnerSettings = {
  alertPrefs: Record<string, { telegram?: boolean }>;
  digestHourUtc: number | null;
  digestOptout: boolean;
  telegramLinked: boolean;
  telegramLinkedAt: string | null;
  streamPubkeySet: boolean;
};

export type MockState = {
  agentId: string;
  status: 'running' | 'paused' | 'revoked';
  approvalPending: boolean;
  approvalDecided?: { decision: string; reason?: string };
  createBody?: Record<string, unknown>;
  revokeCalled: boolean;
  /** Override the agent account balance (wei) — e.g. below the window cap to trigger the
   *  cockpit low-balance warning. */
  accountBalanceWei?: string;
  // — Phase 2 —
  agents: MockAgent[];
  links: MockLink[];
  delegations: MockDelegation[];
  /** Extra `delegation` SSE frames per agent id, appended to that agent's stream. */
  delegationEvents: Record<string, unknown[]>;
  /** Agent ids whose guardian batch-revoke should FAIL (C-2 partial-failure path). */
  failRevokeIds: string[];
  /** Single POST /:id/revoke answers 502 guardian_revoke_failed (C-2 steer). */
  singleRevokeFails?: boolean;
  rulesBody?: Record<string, unknown>;
  linkActions: Array<{ linkId: string; body: Record<string, unknown> }>;
  revokeBatchBody?: Record<string, unknown>;
  // — Phase 3 —
  alerts: MockAlert[];
  ownerSettings: MockOwnerSettings;
  settingsPatches: Array<Record<string, unknown>>;
  /** POST /api/owner/telegram/* answers 503 when false (bot unconfigured). */
  telegramConfigured: boolean;
  /** GET /api/digest serves this; POST /mark swaps in the empty digest. */
  digest: Record<string, unknown>;
  digestMarked: boolean;
};

export function mockAgent(agentId: string, name: string, over: Partial<MockAgent> = {}): MockAgent {
  return {
    agentId,
    name,
    status: 'active',
    accountAddr: '0x1111111111111111111111111111111111111111',
    sessionKeyAddr: '0x2222222222222222222222222222222222222222',
    accountBalanceWei: '250000000000000000',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function mockAlert(id: string, over: Partial<MockAlert> = {}): MockAlert {
  return {
    id,
    ownerAddr: '0x3333333333333333333333333333333333333333',
    agentId: 'agent-1',
    class: 'info',
    kind: 'revoked',
    status: 'unread',
    summary: 'Something happened with your agent.',
    refs: {},
    count: 1,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

export function emptyDigest(): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    since: new Date(Date.now() - 3600_000).toISOString(),
    agents: [],
    links: [],
    totals: { spendWei: '0', actions: 0, decisions: 0 },
    empty: true,
  };
}

export function sampleDigest(): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    since: new Date(Date.now() - 86_400_000).toISOString(),
    agents: [
      {
        agentId: 'agent-1',
        name: 'Treasury helper',
        status: 'running',
        spendWei: '20000000000000000',
        balanceWei: '230000000000000000',
        balanceChangeWei: '-20000000000000000',
        actions: 2,
        blocks: 1,
        modifies: 0,
        approvals: { approved: 1, denied: 0, expired: 0 },
        delegationsTerminal: {},
      },
    ],
    links: [],
    totals: { spendWei: '20000000000000000', actions: 2, decisions: 1 },
    empty: false,
  };
}

export function freshState(): MockState {
  return {
    agentId: 'agent-1',
    status: 'running',
    approvalPending: true,
    revokeCalled: false,
    agents: [mockAgent('agent-1', 'Treasury helper')],
    links: [],
    delegations: [],
    delegationEvents: {},
    failRevokeIds: [],
    linkActions: [],
    alerts: [],
    ownerSettings: {
      alertPrefs: {},
      digestHourUtc: 8,
      digestOptout: false,
      telegramLinked: false,
      telegramLinkedAt: null,
      streamPubkeySet: false,
    },
    settingsPatches: [],
    telegramConfigured: true,
    digest: sampleDigest(),
    digestMarked: false,
  };
}

const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function agentDetail(state: MockState) {
  return {
    status: state.status,
    policy: {
      perTransferCapWei: '10000000000000000',
      windowCapWei: '50000000000000000',
      windowSeconds: 86400,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      allowlist: [PAYEE],
    },
    accountBalance: state.accountBalanceWei ?? '250000000000000000',
    sessionExpiry: Math.floor(Date.now() / 1000) + 7 * 86400,
    addresses: {
      account: '0x1111111111111111111111111111111111111111',
      sessionKey: '0x2222222222222222222222222222222222222222',
      owner: '0x3333333333333333333333333333333333333333',
    },
    encryptedAuditKey: (state.createBody?.encryptedAuditKey as string) ?? null,
    agent: {
      id: state.agentId,
      name: 'Treasury helper',
      gatewayRules: (state.rulesBody?.rules as unknown[] | undefined) ?? [],
    },
  };
}

function sseBody(state: MockState, agentId: string): string {
  const frames: unknown[] = [
    { type: 'status', status: state.status },
    { type: 'reasoning', text: 'Checking the beneficiary balance before deciding whether to top up.' },
    { type: 'trace', kind: 'inference', seq: 1, summary: 'Reasoned via 0G Compute' },
    ...(state.delegationEvents[agentId] ?? []),
  ];
  if (state.approvalPending) {
    frames.push({
      type: 'approval',
      approvalId: 'apr-1',
      summary: 'Send 0.02 0G to the beneficiary (above your usual pattern)',
      to: PAYEE,
      valueWei: '20000000000000000',
    });
  } else if (state.approvalDecided) {
    frames.push({
      type: 'trace',
      kind: 'consent',
      seq: 2,
      summary: `Owner ${state.approvalDecided.decision}d the request`,
    });
  }
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
}

export async function installMockApi(page: Page, state: MockState): Promise<void> {
  await page.route('**/mock-api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/mock-api/, '');
    const method = route.request().method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (method === 'POST' && path === '/api/agents') {
      state.createBody = route.request().postDataJSON() as Record<string, unknown>;
      const newId = state.agents.some((a) => a.agentId === state.agentId)
        ? `agent-${state.agents.length + 1}`
        : state.agentId;
      state.agents.push(mockAgent(newId, String(state.createBody['name'] ?? newId)));
      return json(200, {
        agentId: newId,
        accountAddr: '0x1111111111111111111111111111111111111111',
        sessionKeyAddr: '0x2222222222222222222222222222222222222222',
        gatewayToken: 'gw_tok_shown_once_abc123',
        txHashes: ['0x' + 'a'.repeat(64)],
      });
    }
    if (method === 'GET' && path === '/api/agents') {
      return json(200, { agents: state.agents });
    }
    // — Phase 5: create funnel —
    if (method === 'GET' && path === '/api/job-specs') {
      return json(200, { specs: [] });
    }
    if (method === 'POST' && path === '/api/create/elevate') {
      // A deterministic, safe provider draft — no address, no fee (never-guess-money).
      return json(200, {
        draft: {
          proposedRole: 'provider',
          rationale: 'You want calibrated odds on market questions — set up as a provider that only produces work.',
          capabilityLabel: 'market forecaster',
          serviceSpec: 'calibrated probability estimates for market questions',
          moneyPower: 'cannot-move-money',
          unsureFields: [],
          confidence: 'high',
        },
      });
    }
    if (method === 'POST' && path === '/api/agents/revoke-batch') {
      state.revokeBatchBody = route.request().postDataJSON() as Record<string, unknown>;
      const ids = (state.revokeBatchBody['agentIds'] as string[] | undefined) ?? [];
      const results = ids.map((agentId) => {
        const agent = state.agents.find((a) => a.agentId === agentId);
        if (state.failRevokeIds.includes(agentId)) {
          return {
            agentId,
            ok: false,
            error: 'guardian_revoke_failed',
            ownerRevokeFallback: {
              accountAddr: agent?.accountAddr ?? '0x1111111111111111111111111111111111111111',
              method: 'revoke()',
              hint: 'Revoke directly from your owner wallet.',
            },
          };
        }
        if (agent?.status === 'revoked') return { agentId, ok: true, alreadyRevoked: true };
        if (agent) agent.status = 'revoked';
        return { agentId, ok: true, txHash: '0x' + 'c'.repeat(64) };
      });
      return json(200, { results });
    }
    if (method === 'PATCH' && /^\/api\/agents\/[^/]+\/rules$/.test(path)) {
      state.rulesBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(200, { ok: true, rules: state.rulesBody['rules'] });
    }
    if (method === 'POST' && path === '/api/links') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const link: MockLink = {
        id: `link-${state.links.length + 1}`,
        ownerAddr: '0x3333333333333333333333333333333333333333',
        fromAgentId: String(body['fromAgentId']),
        toAgentId: String(body['toAgentId']),
        mode: (body['mode'] as 'auto' | 'supervised' | undefined) ?? 'auto',
        status: 'active',
        createdAt: new Date().toISOString(),
        delegationCount: 0,
      };
      state.links.push(link);
      return json(201, { link });
    }
    if (method === 'GET' && path === '/api/links') {
      return json(200, {
        links: state.links.map((l) => ({
          ...l,
          delegationCount: state.delegations.filter((d) => d.linkId === l.id).length,
        })),
      });
    }
    if (method === 'POST' && /^\/api\/links\/[^/]+$/.test(path)) {
      const linkId = path.split('/').pop() ?? '';
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.linkActions.push({ linkId, body });
      const link = state.links.find((l) => l.id === linkId);
      if (!link) return json(404, { error: { message: 'not found' } });
      if (typeof body['mode'] === 'string') link.mode = body['mode'] as MockLink['mode'];
      else if (body['action'] === 'pause') link.status = 'paused';
      else if (body['action'] === 'resume') link.status = 'active';
      else if (body['action'] === 'remove') link.status = 'removed';
      return json(200, { link });
    }
    if (method === 'GET' && path === '/api/delegations') {
      return json(200, { delegations: state.delegations });
    }
    // — Phase 3: owner stream, alerts, digest, settings, telegram —
    if (method === 'GET' && path === '/api/owner/stream') {
      const frames = state.alerts.map((alert) => ({ type: 'alert', alert }));
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
      });
    }
    if (method === 'GET' && path === '/api/alerts') {
      const unread = state.alerts.filter((a) => a.status === 'unread').length;
      return json(200, {
        alerts: [...state.alerts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        unread,
      });
    }
    if (method === 'POST' && path === '/api/alerts/read-all') {
      let marked = 0;
      for (const a of state.alerts) {
        if (a.class === 'info' && a.status === 'unread') {
          a.status = 'read';
          marked += 1;
        }
      }
      return json(200, { ok: true, marked });
    }
    if (method === 'POST' && /^\/api\/alerts\/[^/]+$/.test(path)) {
      const id = path.split('/').pop() ?? '';
      const body = route.request().postDataJSON() as { action: 'read' | 'dismiss' };
      const alert = state.alerts.find((a) => a.id === id);
      if (!alert) return json(404, { error: { message: 'not found' } });
      if (body.action === 'dismiss' && alert.kind === 'approval_required') {
        return json(409, { error: { message: 'decision alerts resolve via their approval' } });
      }
      if (body.action === 'read') alert.status = 'read';
      else {
        alert.status = 'dismissed';
        alert.resolution = 'dismissed';
        alert.resolvedAt = new Date().toISOString();
      }
      return json(200, { ok: true, alert });
    }
    if (method === 'GET' && path === '/api/digest') {
      return json(200, { digest: state.digestMarked ? emptyDigest() : state.digest });
    }
    if (method === 'POST' && path === '/api/digest/mark') {
      state.digestMarked = true;
      return json(200, { ok: true, digest: state.digest });
    }
    if (method === 'GET' && path === '/api/owner/settings') {
      return json(200, state.ownerSettings);
    }
    if (method === 'PATCH' && path === '/api/owner/settings') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.settingsPatches.push(body);
      if (typeof body['streamPubkey'] === 'string') {
        if (state.ownerSettings.streamPubkeySet) {
          return json(409, { error: { message: 'owner-stream key is already set' } });
        }
        state.ownerSettings.streamPubkeySet = true;
      }
      if (body['alertPrefs']) {
        state.ownerSettings.alertPrefs = body['alertPrefs'] as Record<string, { telegram?: boolean }>;
      }
      if (typeof body['digestHourUtc'] === 'number') state.ownerSettings.digestHourUtc = body['digestHourUtc'];
      if (typeof body['digestOptout'] === 'boolean') state.ownerSettings.digestOptout = body['digestOptout'];
      return json(200, { ok: true, ...state.ownerSettings });
    }
    if (method === 'POST' && path === '/api/owner/telegram/link') {
      if (!state.telegramConfigured) {
        return json(503, { error: { message: 'telegram is not configured on this deployment' } });
      }
      return json(200, {
        url: 'https://t.me/leash_test_bot?start=e2e-token',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (method === 'DELETE' && path === '/api/owner/telegram') {
      state.ownerSettings.telegramLinked = false;
      state.ownerSettings.telegramLinkedAt = null;
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/api/owner/telegram/ping') {
      if (!state.ownerSettings.telegramLinked) return json(409, { error: { message: 'telegram is not linked' } });
      return json(200, { ok: true });
    }
    if (method === 'GET' && path === '/api/owner/records') {
      return json(200, { records: [], nextCursor: null, chainVerified: true });
    }
    if (method === 'GET' && path === '/api/owner/audit') {
      return json(200, []);
    }

    if (method === 'GET' && /^\/api\/agents\/[^/]+\/stream$/.test(path)) {
      const agentId = path.split('/')[3] ?? '';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(state, agentId) });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/traces/.test(path)) {
      return json(200, { records: [], nextCursor: null, chainVerified: true });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/audit$/.test(path)) {
      return json(200, []);
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+$/.test(path)) {
      return json(200, agentDetail(state));
    }
    if (method === 'POST' && /^\/api\/approvals\//.test(path)) {
      const approvalId = path.split('/').pop() ?? '';
      state.approvalDecided = route.request().postDataJSON() as { decision: string; reason?: string };
      state.approvalPending = false;
      // Phase 3: the decision auto-resolves its alert (any channel — here, the app).
      for (const a of state.alerts) {
        if (a.kind === 'approval_required' && a.refs['approvalId'] === approvalId) {
          a.status = 'resolved';
          a.resolution = state.approvalDecided.decision;
          a.resolvedVia = 'app';
          a.resolvedAt = new Date().toISOString();
        }
      }
      return json(200, { ok: true });
    }
    if (method === 'POST' && /\/revoke$/.test(path)) {
      state.revokeCalled = true;
      if (state.singleRevokeFails) {
        return json(502, {
          ok: false,
          error: 'guardian_revoke_failed',
          ownerRevokeFallback: {
            accountAddr: '0x1111111111111111111111111111111111111111',
            method: 'revoke()',
            hint: 'Revoke directly from your owner wallet.',
          },
        });
      }
      state.status = 'revoked';
      return json(200, { ok: true, txHash: '0x' + 'b'.repeat(64) });
    }
    if (method === 'POST' && /\/start$/.test(path)) {
      state.status = 'running';
      return json(200, { ok: true });
    }
    if (method === 'POST' && /\/stop$/.test(path)) {
      state.status = 'paused';
      return json(200, { ok: true });
    }
    if (method === 'POST' && /\/rotate$/.test(path)) {
      return json(200, { gatewayToken: 'gw_tok_rotated_xyz789' });
    }
    return json(404, { error: { message: `no mock for ${method} ${path}` } });
  });
}

export const MOCK_PAYEE = PAYEE;
