// File: web/e2e/mocks.ts
// Route-mocked Phase-1 backend for Playwright. Same-origin under /mock-api (see
// playwright.config.ts NEXT_PUBLIC_API_URL) so no CORS. Stateful per test.
import type { Page, Route } from '@playwright/test';

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
};

export function freshState(): MockState {
  return { agentId: 'agent-1', status: 'running', approvalPending: true, revokeCalled: false };
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
  };
}

function sseBody(state: MockState): string {
  const frames: unknown[] = [
    { type: 'status', status: state.status },
    { type: 'reasoning', text: 'Checking the beneficiary balance before deciding whether to top up.' },
    { type: 'trace', kind: 'inference', seq: 1, summary: 'Reasoned via 0G Compute' },
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
      return json(200, {
        agentId: state.agentId,
        accountAddr: '0x1111111111111111111111111111111111111111',
        sessionKeyAddr: '0x2222222222222222222222222222222222222222',
        gatewayToken: 'gw_tok_shown_once_abc123',
        txHashes: ['0x' + 'a'.repeat(64)],
      });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/stream$/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(state) });
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
      state.approvalDecided = route.request().postDataJSON() as { decision: string; reason?: string };
      state.approvalPending = false;
      return json(200, { ok: true });
    }
    if (method === 'POST' && /\/revoke$/.test(path)) {
      state.revokeCalled = true;
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
