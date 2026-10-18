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
  /** AQ-A0-Q2VIS: emit the D-4 rationale + degenerate-cycle frames (opt-in, so existing specs are unaffected). */
  q2vis?: boolean;
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
  // — Phase 5.5: conversational direction —
  /** Captured body of the last POST /direct/:id/confirm. */
  confirmDirectionBody?: Record<string, unknown>;
  windDownCalled: boolean;
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
    windDownCalled: false,
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

/**
 * AQ-A0-Q2VIS D-2: a realistic DELIBERATION frame. The old mock sent a single tidy sentence, which
 * is exactly what hid the Q2 defect — in production this channel carried the decision JSON, and at
 * 4 230 median chars (p100 13 818) of model-voice prose with markdown headers and self-corrections.
 * The mock now reflects that shape so the surface is exercised against what it will really receive.
 */
const DELIBERATION = [
  'Okay, let me work through this carefully.',
  '',
  '## Step 1 — read the observation',
  'The beneficiary holds 0.012 0G and the target is 0.05 0G, so it is short by 0.038 0G.',
  'The configured top-up is 0.01 0G and the per-transfer cap is 0.02 0G.',
  '',
  '## Step 2 — check the policy',
  'Remaining window allowance is 0.1 0G, which comfortably covers 0.01 0G.',
  'The session is not expired and not revoked. The beneficiary IS on the allowlist.',
  '',
  'Wait — I should double-check the cap. 0.01 0G is below 0.02 0G, so it is fine.',
  'Actually let me reconsider whether to send the full shortfall of 0.038 0G instead...',
  'No. The rule says prefer the configured top-up amount, capped at what the target still needs.',
  '0.01 0G is the configured amount and it is less than the shortfall, so 0.01 0G it is.',
  '',
  'I will output the JSON now.',
].join('\n');

function sseBody(state: MockState, agentId: string): string {
  const frames: unknown[] = [
    { type: 'status', status: state.status },
    {
      type: 'reasoning',
      text: DELIBERATION,
      meta: { truncated: false, loopCount: 3, decisionSource: 'content', clipped: false },
    },
    { type: 'trace', kind: 'inference', seq: 1, summary: 'Reasoned via 0G Compute' },
    ...(state.delegationEvents[agentId] ?? []),
  ];
  // D-4 owner layer + D-2 degenerate-cycle degradation, opt-in per spec so existing specs are
  // untouched by the new frames.
  if (state.q2vis) {
    frames.push({
      type: 'trace',
      kind: 'action',
      seq: 3,
      summary: 'sent 0.01 0G to 0x9c9c…9c9c',
      to: PAYEE,
      valueWei: '10000000000000000',
      txHash: '0x' + 'ab'.repeat(32),
      reason: 'beneficiary below target; within caps',
      rationale:
        'I topped up your beneficiary with 0.01 0G because its balance had fallen to 0.012 0G, below the 0.05 0G you asked me to keep it at.',
    });
    // A SERVER-COMPOSED stand-down: the runtime synthesizes these when the leash binds (window
    // exhausted, boundary active, tool rail gone), so `reason` is the server's sentence and the
    // agent authored nothing — no `rationale`. summarize() prefixes it, which is exactly what
    // defeated the old `why === summary` dedupe and let the server's words be quoted back as the
    // agent's. Shape copied from treasury-graph.ts `outcomeSummary` + the OverWindowCap branch.
    frames.push({
      type: 'trace',
      kind: 'decision',
      seq: 4,
      summary: 'stood down: spending window exhausted — standing down until it resets',
      reason: 'spending window exhausted — standing down until it resets',
    });
    frames.push({
      type: 'reasoning',
      text:
        '[degenerate cycle: the model restated its answer 40x until it hit the token cap '
        + '(finish_reason=length, 64254 chars). Head and tail kept; the repetition is not stored.]\n'
        + '--- head ---\nLet me decide. {"action":"send"}\n--- tail ---\n{"action":"send"}',
      meta: { truncated: true, loopCount: 40, decisionSource: 'scavenge', clipped: true },
    });
  }
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
  // NOTE on the SSE routes below, and why they REPLAY their frames on every request.
  //
  // A mocked SSE route can only fulfil a FINITE body, so each stream "ends" the moment its last
  // frame is written. `connectSse` correctly reads a clean body end as a dropped connection and
  // reconnects with 1s/2s/4s backoff (lib/sse.ts:43-71), and these handlers then serve the same
  // canned frames again. Two consequences, and they pull in opposite directions:
  //
  //  - The replay is LOAD-BEARING. It is the only push channel this mock has. A spec that POSTs
  //    /pause or /revoke and then expects the cockpit to show the new state depends on the next
  //    reconnect re-serving `sseBody` with the mutated `state`. Suppressing the replay to match
  //    the real hub (which sends no history on connect — backend/src/sse/hub.ts:111-117) was
  //    tried and reverted: it took out 19 specs across a11y/direct/funnel/happy-path/phase2/
  //    phase3, because "faithful to the hub" and "able to push a state change" are the same
  //    mechanism here. Do not re-attempt without giving the mock a real push channel first.
  //  - The replay DUPLICATES feed rows. The feed appends with a fresh id per event and has no
  //    dedupe key (app/agents/[id]/page.tsx:237-241), so the row count grows with how long a
  //    spec RUNS: measured 1x in the fast specs and 3x in the slower screenshot-taking evidence
  //    run. Mock-only — the real hub does not replay, so production never sees this.
  //
  // So the duplication is a property of the harness that specs must be written around:
  // **never assert a COUNT over feed rows, and never leave a feed locator unqualified.** Use
  // `.first()`/`.last()` and `toBeVisible()`, or scope the count to a single row.
  // Root cause write-up: docs/evidence/aq-a0-q2vis/N-FEED-TRIPLICATION-ROOT-CAUSE.md (0g-fleet).
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

    // — Phase 5.5: conversational direction —
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/direct\/[^/]+\/confirm$/.test(path)) {
      state.confirmDirectionBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(200, { ok: true });
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/direct$/.test(path)) {
      // A deterministic, safe treasury redirect — descriptive patch only, NO address/fee.
      return json(200, {
        direction: {
          id: 'dir-1',
          draft: {
            agentId: state.agentId,
            currentRole: 'treasury',
            understanding: 'You want it to keep the balance at 2 0G instead of 1.',
            goalPatch: { targetBalanceWei: '2000000000000000000', topUpWei: '500000000000000000' },
            moneyPower: 'can-move-money',
            unsureFields: [],
            confidence: 'high',
          },
        },
      });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/status$/.test(path)) {
      return json(200, {
        answer: 'So far I have topped up the beneficiary once, sending 0.02 0G.',
        asOfSeq: 3,
        quarantined: true,
      });
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/wind-down$/.test(path)) {
      state.windDownCalled = true;
      return json(200, { ok: true });
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
    // — Stage D: capability granting —
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/capabilities$/.test(path)) {
      return json(200, CAPABILITY_ENVELOPE);
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/capabilities\/preset$/.test(path)) {
      // Resolve/preview (no txHash) or record (txHash) — both echo the preset.
      return json(200, { ok: true, preset: CAPABILITY_PRESET, recorded: false });
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/capabilities\/rule$/.test(path)) {
      return json(200, { ok: true });
    }

    return json(404, { error: { message: `no mock for ${method} ${path}` } });
  });
}

// A Stage-D capability envelope fixture: one active grant, one applied preset, and
// one PENDING JIT request (so the cockpit renders the CapabilityDecisionCard). The
// decoded intent carries markup to prove it is rendered as PLAIN TEXT, never HTML.
const CAPABILITY_PRESET = {
  key: 'defi_trader',
  label: 'DeFi Trader',
  rules: [
    {
      target: '0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30',
      selector: '0x095ea7b3',
      recipientMode: 'self',
      spenderSet: ['0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30'],
      perCallCap: '1000000000000000000',
      windowCapCall: '5000000000000000000',
    },
  ],
  denyList: ['new_spender', 'new_recipient', 'bridge'],
};

const CAPABILITY_ENVELOPE = {
  grants: [
    {
      id: 'grant-1',
      agentId: 'agent-1',
      ownerAddr: '0x3333333333333333333333333333333333333333',
      target: '0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30',
      selector: '0x095ea7b3',
      recipientMode: 'self',
      spenderSet: ['0x4CD6ed4E6abd715D10E49AD99d2e3866bF46ee30'],
      perCallCap: '1000000000000000000',
      windowCapCall: '5000000000000000000',
      codehash: null,
      source: 'preset:defi_trader',
      status: 'active',
      txHash: '0x' + 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  presets: [{ presetKey: 'defi_trader' }],
  recentRequests: [
    {
      id: 'req-1',
      decoded: {
        label: 'UNVERIFIED',
        target: '0xf951F8655C0a549c6187aB4b6Aec9fE76E402e2d',
        selector: '0x6e553f65',
        signature: 'deposit(uint256,address)',
        value: '0',
        humanReadable: 'Deposit 5 TUSD-D into a vault <script>ignore</script>',
        novelty: ['new_target'],
      },
      novelty: ['new_target'],
      callHash: ('0x' + 'b'.repeat(64)) as `0x${string}`,
      status: 'pending',
      approvalId: 'approval-jit-1',
    },
  ],
};

export const MOCK_PAYEE = PAYEE;
