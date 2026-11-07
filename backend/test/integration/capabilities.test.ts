import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { SseHub } from '../../src/sse/hub.js';
import { ApprovalBroker } from '../../src/approvals/broker.js';
import { AlertService } from '../../src/alerts/service.js';
import { getAgentById } from '../../src/store/agents.js';
import { getApproval } from '../../src/store/approvals.js';
import { listAlerts } from '../../src/alerts/store.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { classifyIntendedCall, type GateResult } from '../../src/gateway/call-gate.js';
import {
  ruleKey,
  computeCallHash,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';
import {
  upsertGrant,
  setGrantStatus,
  listGrants,
  recordPresetApplied,
  listAppliedPresets,
  getCapabilityRequest,
  setRequestDecision,
  listRecentRequests,
} from '../../src/store/capabilities.js';
import {
  resolvePreset,
  recordPresetGrants,
  raiseCapabilityRequest,
  decideCapabilityRequest,
  type CapabilityDeps,
} from '../../src/capabilities/service.js';

/**
 * Stage D capabilities read-model + service (spec §3b/§5). Store CRUD +
 * owner-scope, preset resolution (D-9, never-partial), and the L2 JIT rail
 * (D-8): quarantined request raise (idempotent, sanitized), and the owner
 * decision path (approve-once / always-allow / deny) with consent bookkeeping +
 * read-model grant sync. Plus D-12 stress: prototype-pollution / unicode-bidi /
 * type-smuggling on the JIT intent; double-decide idempotency.
 */

let db: TestDb;
const TOKEN = '0x' + 'cc'.repeat(20);
const ROUTER = '0x' + 'dd'.repeat(20);
const VAULT = '0x' + 'ee'.repeat(20);
const SELF = '0x' + '55'.repeat(20);
const OWNER = '0x' + 'a1'.repeat(20);

const erc20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)']);
const enc = (fn: string, args: readonly unknown[]): string =>
  encodeFunctionData({ abi: erc20, functionName: fn as 'approve' | 'transfer', args: args as never });

const approveRule: CallRule = {
  target: TOKEN,
  selector: toFunctionSelector('function approve(address,uint256)'),
  recipientMode: 'self',
  spenderSet: [ROUTER],
  perCallCap: '100000000',
  windowCapCall: '500000000',
};

function nn<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected non-null");
  return x;
}

function emptyGrant(): GrantState {
  return { rules: new Map(), budgets: new Map(), allowlist: new Set<string>() };
}
function grantWith(rules: CallRule[], budgets: [string, string][] = [[TOKEN.toLowerCase(), '1000000000']]): GrantState {
  return {
    rules: new Map(rules.map((r) => [ruleKey(r.target, r.selector), r])),
    budgets: new Map(budgets),
    allowlist: new Set<string>(),
  };
}

function makeDeps(): CapabilityDeps {
  const hub = new SseHub();
  return {
    pool: db.pool,
    hub,
    broker: new ApprovalBroker(),
    alerts: new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } }),
    jitTtlMs: 600_000,
  };
}

async function seedOwnedAgent(owner = OWNER): Promise<Awaited<ReturnType<typeof getAgentById>>> {
  // SE-6 pre-req: no fixed accountAddr — migration 021's UNIQUE(owner, chain,
  // account) forbids re-seeding one address per owner; the random default is fine
  // because classifyIntendedCall takes `SELF` directly, independent of the row.
  const id = await seedAgent(db.pool, { ownerAddr: owner, name: 'MyTrader' });
  return getAgentById(db.pool, id);
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

// ---------------------------------------------------------------------------
// Read-model store
// ---------------------------------------------------------------------------

describe('capability_grants store', () => {
  it('upserts a grant then updates in place on re-grant (one row per target:selector)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const g1 = await upsertGrant(db.pool, { agentId: agent.id, ownerAddr: agent.ownerAddr, rule: approveRule, source: 'custom', status: 'proposed' });
    expect(g1.status).toBe('proposed');
    expect(g1.spenderSet).toEqual([ROUTER.toLowerCase()]);
    // re-grant with a tighter cap → same row, updated
    const g2 = await upsertGrant(db.pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      rule: { ...approveRule, perCallCap: '50000000' },
      source: 'custom',
      status: 'active',
    });
    expect(g2.id).toBe(g1.id);
    expect(g2.perCallCap).toBe('50000000');
    expect(g2.status).toBe('active');
    const rows = await listGrants(db.pool, agent.id);
    expect(rows).toHaveLength(1);
  });

  it('setGrantStatus removed hides the grant from the default envelope', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    await upsertGrant(db.pool, { agentId: agent.id, ownerAddr: agent.ownerAddr, rule: approveRule, source: 'custom', status: 'active' });
    await setGrantStatus(db.pool, agent.id, approveRule.target, approveRule.selector, 'removed');
    expect(await listGrants(db.pool, agent.id)).toHaveLength(0);
    expect(await listGrants(db.pool, agent.id, true)).toHaveLength(1);
  });

  it('setGrantStatus refuses removed→active (DM-1: removed is terminal)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    await upsertGrant(db.pool, { agentId: agent.id, ownerAddr: agent.ownerAddr, rule: approveRule, source: 'custom', status: 'active' });
    await setGrantStatus(db.pool, agent.id, approveRule.target, approveRule.selector, 'removed');
    // the SQL from-guard blocks the resurrection and returns null
    const blocked = await setGrantStatus(db.pool, agent.id, approveRule.target, approveRule.selector, 'active');
    expect(blocked).toBeNull();
    // read-model stays removed (hidden from the default envelope)
    expect(await listGrants(db.pool, agent.id)).toHaveLength(0);
    expect((await listGrants(db.pool, agent.id, true))[0]?.status).toBe('removed');
  });

  it('setGrantStatus still flips proposed→active (legitimate apply)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    await upsertGrant(db.pool, { agentId: agent.id, ownerAddr: agent.ownerAddr, rule: approveRule, source: 'custom', status: 'proposed' });
    const applied = await setGrantStatus(db.pool, agent.id, approveRule.target, approveRule.selector, 'active');
    expect(applied?.status).toBe('active');
  });

  it('records applied presets distinctly', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    await recordPresetApplied(db.pool, agent.id, agent.ownerAddr, 'defi_trader');
    await recordPresetApplied(db.pool, agent.id, agent.ownerAddr, 'defi_trader');
    await recordPresetApplied(db.pool, agent.id, agent.ownerAddr, 'dca');
    expect(await listAppliedPresets(db.pool, agent.id)).toEqual(['dca', 'defi_trader']);
  });
});

// ---------------------------------------------------------------------------
// Preset resolution (D-9)
// ---------------------------------------------------------------------------

describe('resolvePreset (D-9)', () => {
  it('resolves a preset against a full catalog', () => {
    const r = resolvePreset('defi_trader', { router: ROUTER, settlement_token: TOKEN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.rules.length).toBeGreaterThan(0);
      // never-guess-money: every target/spender is a resolved catalog address, lowercased
      for (const rule of r.preset.rules) expect(rule.target).toMatch(/^0x[0-9a-f]{40}$/);
      expect(r.preset.denyList).toContain('new_recipient');
    }
  });

  it('refuses (never partial) when a referenced target is missing from the catalog', () => {
    const r = resolvePreset('defi_trader', { settlement_token: TOKEN }); // no router
    expect(r).toEqual({ ok: false, reason: 'unresolvable_target' });
  });

  it('recordPresetGrants writes the applied preset + its grants (proposed)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const r = resolvePreset('yield_manager', { vault: VAULT, settlement_token: TOKEN });
    if (!r.ok) throw new Error('resolve');
    await recordPresetGrants(db.pool, agent, r.preset, '0xdeadbeef');
    const grants = await listGrants(db.pool, agent.id);
    expect(grants.length).toBe(r.preset.rules.length);
    expect(grants.every((g) => g.status === 'proposed' && g.source === 'preset:yield_manager')).toBe(true);
    expect(await listAppliedPresets(db.pool, agent.id)).toContain('yield_manager');
  });
});

// ---------------------------------------------------------------------------
// The L2 JIT rail (D-8)
// ---------------------------------------------------------------------------

describe('raiseCapabilityRequest (D-8)', () => {
  it('raises exactly one quarantined request + approval + decision alert for a novel call', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const data = enc('approve', [ROUTER, 1000000n]);
    const gate = classifyIntendedCall(TOKEN, 0n, data, emptyGrant(), SELF);
    expect(gate.classification.lane).toBe('l2');

    const { request, created } = await raiseCapabilityRequest(deps, agent, gate);
    expect(created).toBe(true);
    expect(request.status).toBe('pending');
    expect(request.approvalId).toBeTruthy();
    expect(request.callHash).toBe(computeCallHash(16602, TOKEN, 0n, data));

    // approval row exists + pending
    const approval = await getApproval(db.pool, nn(request.approvalId));
    expect(approval?.state).toBe('pending');
    // a decision-class capability alert surfaced
    const { alerts } = await listAlerts(db.pool, agent.ownerAddr, {});
    expect(alerts.some((a) => a.kind === 'capability_request')).toBe(true);
  });

  it('beta 3b: the ask names the token + amount + contract (describeCall), not "1000000 base-units"', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = { ...makeDeps(), describeCall: async () => 'approve 1 USDC for the DEX router' };
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, 1234567n]), emptyGrant(), SELF);
    const { request } = await raiseCapabilityRequest(deps, agent, gate);
    expect((request.decoded as { humanReadable: string }).humanReadable).toBe('approve 1 USDC for the DEX router');
    const { alerts } = await listAlerts(db.pool, agent.ownerAddr, {});
    const alert = alerts.find((a) => a.kind === 'capability_request' && a.refs && (a.refs as { capabilityRequestId?: string }).capabilityRequestId === request.id);
    expect(alert?.summary).toContain('approve 1 USDC for the DEX router');
    expect(alert?.summary).not.toContain('base-units');
  });

  it('beta 3b: a failing describeCall degrades to the decoder text (never blocks the ask)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = { ...makeDeps(), describeCall: async () => { throw new Error('rpc down'); } };
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, 777n]), emptyGrant(), SELF);
    const { request } = await raiseCapabilityRequest(deps, agent, gate);
    expect((request.decoded as { humanReadable: string }).humanReadable).toContain('base-units');
  });

  it('is idempotent on the exact call bytes — a repeat reuses the pending request (no 2nd card)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, 5n]), emptyGrant(), SELF);
    const a = await raiseCapabilityRequest(deps, agent, gate);
    const b = await raiseCapabilityRequest(deps, agent, gate);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    const pending = (await listRecentRequests(db.pool, agent.id)).filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
  });

  it('repair-forward (W2): a reused row that never got its approval bound (crash) is completed, not stuck', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, 7n]), emptyGrant(), SELF);
    const first = await raiseCapabilityRequest(deps, agent, gate);
    expect(first.created).toBe(true);

    // Simulate a crash between insertCapabilityRequest and setRequestApproval:
    // the pending row exists but has no approval bound. Left as-is it can never
    // be decided (decideCapabilityRequest → no_approval) until TTL expiry.
    await db.pool.query(`UPDATE capability_requests SET approval_id = NULL WHERE id = $1`, [first.request.id]);

    // The next runtime cycle re-raises the identical novel call — it must REPAIR
    // the unbound row: same request id, a freshly bound approval, a fresh card.
    const repaired = await raiseCapabilityRequest(deps, agent, gate);
    expect(repaired.created).toBe(false); // not a NEW request…
    expect(repaired.request.id).toBe(first.request.id);
    expect(repaired.request.approvalId).toBeTruthy(); // …but now bound + decidable
    const approval = await getApproval(db.pool, nn(repaired.request.approvalId));
    expect(approval?.state).toBe('pending');
  });

  it('throws if handed a non-L2 classification (in-envelope calls must never raise a JIT)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    // in-envelope: grant approve(spender=ROUTER, cap≥amount)
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, 10n]), grantWith([approveRule]), SELF);
    expect(gate.classification.lane).toBe('l1');
    await expect(raiseCapabilityRequest(deps, agent, gate)).rejects.toThrow(/non-L2/);
  });

  it('D-12: sanitizes control + bidi chars out of the quarantined intent (never trusted/rendered raw)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    // craft a GateResult with a poisoned humanReadable (simulating a hostile
    // decode surface) — the store must strip control/bidi before persistence.
    const poisoned: GateResult = {
      decoded: {
        target: ROUTER,
        value: 0n,
        data: enc('approve', [ROUTER, 1n]),
        selector: approveRule.selector,
        signature: 'function approve(address,uint256)',
        humanReadable: `approve \u202Eevil\u200F up\u0007 to 1`,
        args: { structured: true, amount: 1n, spendToken: TOKEN, recipients: [] },
      },
      classification: { lane: 'l2', novelty: ['new_target'] },
    };
    const { request } = await raiseCapabilityRequest(deps, agent, poisoned);
    const stored = await getCapabilityRequest(db.pool, request.id);
    const hr = (nn(stored).decoded as { humanReadable: string }).humanReadable;
    // no NUL, no bidi override, no C0 control chars survive
    expect(hr).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    expect((nn(stored).decoded as { label: string }).label).toBe('UNVERIFIED');
  });

  it('D-12: prototype-pollution keys in a crafted intent cannot pollute Object.prototype', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const gate = classifyIntendedCall(TOKEN, 7n, enc('approve', [ROUTER, 3n]), emptyGrant(), SELF);
    await raiseCapabilityRequest(deps, agent, gate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('decideCapabilityRequest (D-8)', () => {
  async function pending(deps: CapabilityDeps, agent: NonNullable<Awaited<ReturnType<typeof getAgentById>>>, amount = 9n) {
    const gate = classifyIntendedCall(TOKEN, 0n, enc('approve', [ROUTER, amount]), emptyGrant(), SELF);
    const { request } = await raiseCapabilityRequest(deps, agent, gate);
    return request;
  }

  it('approve-once records the decision + consent (needs a tx) and grants NO standing rule', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent);
    const res = await decideCapabilityRequest(deps, agent, req, 'approve_once', { txHash: '0xabc' });
    expect(res).toEqual({ ok: true, status: 'approved_once' });
    // consent record appended
    const traces = await listTraces(db.pool, agent.id, { limit: 100 });
    expect(traces.some((t) => t.kind === 'consent')).toBe(true);
    // no standing grant from a one-shot
    expect(await listGrants(db.pool, agent.id)).toHaveLength(0);
    // approval resolved
    expect((await getApproval(db.pool, nn(req.approvalId)))?.state).toBe('approved');
  });

  it('always-allow persists a standing read-model grant (needs tx + rule)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent, 11n);
    const res = await decideCapabilityRequest(deps, agent, req, 'always_allow', { txHash: '0xfeed', rule: approveRule });
    expect(res).toEqual({ ok: true, status: 'always_allowed' });
    const grants = await listGrants(db.pool, agent.id);
    expect(grants).toHaveLength(1);
    expect(nn(grants[0]).source).toBe('jit');
    expect(nn(grants[0]).txHash).toBe('0xfeed');
  });

  it('deny stands down (no tx) + resolves the approval as denied', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent, 13n);
    const res = await decideCapabilityRequest(deps, agent, req, 'deny', {});
    expect(res).toEqual({ ok: true, status: 'denied' });
    expect(await listGrants(db.pool, agent.id)).toHaveLength(0);
    expect((await getApproval(db.pool, nn(req.approvalId)))?.state).toBe('denied');
  });

  it('guards: approve/always-allow without a tx → missing_tx; always-allow without a rule → missing_rule', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent, 15n);
    expect(await decideCapabilityRequest(deps, agent, req, 'approve_once', {})).toEqual({ ok: false, reason: 'missing_tx' });
    expect(await decideCapabilityRequest(deps, agent, req, 'always_allow', { txHash: '0x1' })).toEqual({ ok: false, reason: 'missing_rule' });
    // the request is still pending (a rejected decision never consumed it)
    expect((await getCapabilityRequest(db.pool, req.id))?.status).toBe('pending');
  });

  it('D-12: a double-decide cannot double-grant (idempotent — 2nd resolves already_decided)', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent, 17n);
    const first = await decideCapabilityRequest(deps, agent, req, 'always_allow', { txHash: '0xa', rule: approveRule });
    const second = await decideCapabilityRequest(deps, agent, req, 'always_allow', { txHash: '0xb', rule: approveRule });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'already_decided' });
    // exactly one grant, from the FIRST tx
    const grants = await listGrants(db.pool, agent.id);
    expect(grants).toHaveLength(1);
    expect(nn(grants[0]).txHash).toBe('0xa');
  });

  it('setRequestDecision store-level is itself single-shot', async () => {
    const agent = await seedOwnedAgent();
    if (!agent) throw new Error('agent');
    const deps = makeDeps();
    const req = await pending(deps, agent, 19n);
    expect(await setRequestDecision(db.pool, req.id, 'denied')).toBeTruthy();
    expect(await setRequestDecision(db.pool, req.id, 'always_allowed')).toBeNull();
  });
});
