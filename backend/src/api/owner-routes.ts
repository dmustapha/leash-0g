import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivyVerifier } from './privy.js';
import type { SseHub } from '../sse/hub.js';
import { statusEvent, traceEvent } from '../sse/events.js';
import type { ApprovalBroker } from '../approvals/broker.js';
import { generateGatewayToken, hashTokenSecret } from '../crypto/token.js';
import { encryptSecret } from '../crypto/keycrypt.js';
import { appendTrace, listTraces, verifyAgentChainIncremental } from '../trace/trace-store.js';
import {
  getAgentById,
  insertAgent,
  rotateAgentToken,
  countAgentsByOwner,
  createRateRetryAfter,
  listAgentsByOwner,
  updateAgentRules,
} from '../store/agents.js';
import { getApproval, decideApproval } from '../store/approvals.js';
import { applyRevokeFanout } from '../agents/revoke-fanout.js';
import {
  createLink,
  getLink,
  listLinksByOwner,
  setLinkMode,
  setLinkStatus,
  listDelegations,
  DuplicateLinkError,
} from '../coordination/store.js';
import type { DelegationCoordinator } from '../coordination/coordinator.js';
import type { AgentRow, AuditBatch, Link } from '../types.js';
import type { Json } from '../crypto/canonical.js';
import type { ChainOps, RuntimeManager, Settings } from '../server.js';

export interface OwnerApiDeps {
  pool: Pool;
  privy: PrivyVerifier;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: ChainOps;
  runtime: RuntimeManager;
  coordinator: DelegationCoordinator;
  settings: Settings;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const weiSchema = z.string().regex(/^[0-9]{1,30}$/);

/** ONE rules shape for create AND PATCH /rules — the editors cannot drift apart. */
const gatewayRuleSchema = z.object({
  action: z.enum(['block', 'modify', 'require_approval']),
  match: z.string().min(1),
  replacement: z.string().optional(),
});

const rulesPatchSchema = z.object({ rules: z.array(gatewayRuleSchema) });

const linkCreateSchema = z.object({
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  mode: z.enum(['auto', 'supervised']).default('auto'),
});

// Spec §4: { action } XOR { mode } — .strict() unions reject both-or-neither.
const linkUpdateSchema = z.union([
  z.object({ action: z.enum(['pause', 'resume', 'remove']) }).strict(),
  z.object({ mode: z.enum(['auto', 'supervised']) }).strict(),
]);

const revokeBatchSchema = z.object({ agentIds: z.array(z.string().uuid()).min(1).max(16) });

const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  auditPubKey: z.string().regex(/^(0x)?0[23][0-9a-fA-F]{64}$|^(0x)?04[0-9a-fA-F]{128}$/),
  policy: z.object({
    perTransferCapWei: weiSchema,
    windowCapWei: weiSchema,
    windowSeconds: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }),
  allowlist: z.array(addressSchema).min(1),
  goal: z.object({
    beneficiary: addressSchema,
    targetBalanceWei: weiSchema,
    topUpWei: weiSchema,
    model: z.string().min(1).optional(),
  }),
  gatewayRules: z.array(gatewayRuleSchema).optional(),
  /** Opaque KEK-wrapped audit privkey blob, encrypted in the owner's browser. */
  encryptedAuditKey: z.string().min(1).max(20_000).optional(),
}).refine((v) => BigInt(v.goal.topUpWei) <= BigInt(v.policy.perTransferCapWei), {
  // FE validates this too, but the API is the enforcement boundary: a top-up
  // chunk above the per-transfer cap would push every cycle into approval.
  message: 'goal.topUpWei must not exceed policy.perTransferCapWei',
  path: ['goal', 'topUpWei'],
});

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  reason: z.string().max(500).optional(),
});

interface OwnerRequest extends Request {
  ownerAddr?: string;
}

export function ownerRouter(deps: OwnerApiDeps): Router {
  const router = Router();
  // Scoped to /api (every owner route lives there): non-owner paths fall
  // through to the app's 404 instead of a misleading 401.
  router.use('/api', json({ limit: 64 * 1024 }));

  // Privy auth on EVERY owner route (M-01: authed /traces included).
  router.use('/api', (req: OwnerRequest, res: Response, next: NextFunction) => {
    deps.privy
      .verify(req.headers.authorization)
      .then(({ ownerAddr }) => {
        req.ownerAddr = ownerAddr.toLowerCase();
        next();
      })
      .catch(() => res.status(401).json({ error: { message: 'unauthorized' } }));
  });

  /** Load the agent and enforce owner match; responds 403/404 itself. */
  async function requireOwnedAgent(req: OwnerRequest, res: Response): Promise<AgentRow | null> {
    const id = req.params['id'] ?? '';
    const agent = await getAgentById(deps.pool, id);
    if (!agent) {
      res.status(404).json({ error: { message: 'not found' } });
      return null;
    }
    if (agent.ownerAddr !== req.ownerAddr) {
      res.status(403).json({ error: { message: 'forbidden' } });
      return null;
    }
    return agent;
  }

  router.post('/api/agents', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const input = parsed.data;
    const ownerAddr = req.ownerAddr as string;

    // C-1 containment: the deployer key's create gas is the drained resource.
    // Order: cheap shape caps first, then quota, then rate (all before any
    // on-chain spend). Error shapes per PHASE-2 spec §4.
    if (input.allowlist.length > deps.settings.allowlistMax) {
      res.status(400).json({ error: 'allowlist_too_long', max: deps.settings.allowlistMax });
      return;
    }
    if ((input.gatewayRules?.length ?? 0) > deps.settings.rulesMax) {
      res.status(400).json({ error: 'too_many_rules', max: deps.settings.rulesMax });
      return;
    }
    const owned = await countAgentsByOwner(deps.pool, ownerAddr);
    if (owned >= deps.settings.createQuotaPerOwner) {
      // Revoked rows COUNT (07 S6): revoking must not refill an attacker's quota.
      res.status(403).json({ error: 'quota_exceeded', limit: deps.settings.createQuotaPerOwner });
      return;
    }
    const retryAfter = await createRateRetryAfter(deps.pool, ownerAddr, deps.settings.createRatePerHour);
    if (retryAfter !== null) {
      res.setHeader('retry-after', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retryAfter });
      return;
    }

    // Session key EOA is generated server-side and held ONLY encrypted at rest
    // (KEY_ENCRYPTION_SECRET). It is a scoped key: it can act solely within
    // the on-chain policy of the LeashAccount. Owner authority never touches
    // the backend.
    const sessionPk = generatePrivateKey();
    const sessionKeyAddr = privateKeyToAccount(sessionPk).address;

    // Deploy via factory (ops key = deployer + guardian, granted no fund
    // authority) and register in AgentRegistry. register() is called BY the
    // ops key, so the on-chain registry owner is ops; the Privy wallet stored
    // in Postgres (owner_addr) is the authority for the owner API, and the
    // same address is the LeashAccount's contract owner.
    const deployed = await deps.chain.deployAndRegister({
      ownerAddr,
      sessionKeyAddr,
      auditPubKey: input.auditPubKey,
      name: input.name,
      policy: {
        perTransferCap: BigInt(input.policy.perTransferCapWei),
        windowCap: BigInt(input.policy.windowCapWei),
        windowSeconds: input.policy.windowSeconds,
        expiresAt: input.policy.expiresAt,
      },
      allowlist: input.allowlist,
      timelockDelay: deps.settings.defaultTimelockDelay,
    });

    const token = generateGatewayToken();
    const agentId = await insertAgent(deps.pool, {
      chainAgentId: deployed.chainAgentId,
      ownerAddr,
      accountAddr: deployed.accountAddr,
      sessionKeyAddr,
      sessionKeyEnc: encryptSecret(sessionPk, deps.settings.keyEncryptionSecret),
      auditPubkey: input.auditPubKey.replace(/^0x/, ''),
      tokenId: token.tokenId,
      tokenHash: await hashTokenSecret(token.secret),
      name: input.name,
      gatewayRules: input.gatewayRules ?? [],
      goal: input.goal,
      ...(input.encryptedAuditKey !== undefined ? { encryptedAuditKey: input.encryptedAuditKey } : {}),
      // Runtime copy of the token (encrypted at rest) — the co-located runtime
      // is the gateway's only Phase-1 client and needs it at start().
      gatewayTokenEnc: encryptSecret(token.token, deps.settings.keyEncryptionSecret),
      guardianAddr: deployed.guardianAddr,
    });

    // Gas dust so the session key can pay execute() gas; funds stay behind the account.
    await deps.chain.fundSessionKey(sessionKeyAddr, deps.settings.sessionGasDustWei);

    // Shape = FE CreateAgentResponse (web/lib/types.ts).
    res.status(201).json({
      agentId,
      accountAddr: deployed.accountAddr,
      sessionKeyAddr,
      chainAgentId: deployed.chainAgentId.toString(),
      gatewayToken: token.token, // returned ONCE; only the argon2id hash is stored
      txHashes: [deployed.createTx, deployed.registerTx],
    });
  }));

  // Fleet list (spec §4): the authed owner's agents, newest-first, keyset
  // cursor `<createdAtISO>_<id>` (documented choice: created_at DESC with id
  // tiebreak — stable under concurrent creates). Balances are live reads.
  router.get('/api/agents', asyncRoute(async (req: OwnerRequest, res) => {
    const cursorRaw = req.query['cursor'];
    const limitRaw = req.query['limit'];
    const limit = Math.min(Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10) || 50, 200);
    const { agents, nextCursor } = await listAgentsByOwner(deps.pool, req.ownerAddr as string, {
      ...(typeof cursorRaw === 'string' ? { cursor: cursorRaw } : {}),
      limit,
    });
    const summaries = await Promise.all(
      agents.map(async (a) => ({
        agentId: a.id,
        name: a.name,
        status: a.status,
        accountAddr: a.accountAddr,
        sessionKeyAddr: a.sessionKeyAddr,
        accountBalanceWei: (await deps.chain.getBalance(a.accountAddr)).toString(),
        createdAt: a.createdAt,
      })),
    );
    res.json({ agents: summaries, ...(nextCursor !== undefined ? { nextCursor } : {}) });
  }));

  // Rules editor (spec §4, Gate-② parity): replace gatewayRules wholesale,
  // traced 'config' with BOTH original and effective (original+effective
  // discipline — same shape the modify path uses).
  router.patch('/api/agents/:id/rules', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = rulesPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    if (parsed.data.rules.length > deps.settings.rulesMax) {
      res.status(400).json({ error: 'too_many_rules', max: deps.settings.rulesMax });
      return;
    }
    const original = agent.gatewayRules;
    await updateAgentRules(deps.pool, agent.id, parsed.data.rules);
    const rec = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'config',
      // GatewayRule is an interface (no implicit index signature) — safe cast
      // to the Json it structurally is.
      originalRequest: { rules: original } as unknown as Json,
      effectiveRequest: { rules: parsed.data.rules },
      detail: { summary: 'gateway rules replaced by owner', change: 'gatewayRules' },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(rec));
    res.json({ ok: true, rules: parsed.data.rules });
  }));

  router.get('/api/agents/:id', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const [policy, accountBalance] = await Promise.all([
      deps.chain.getPolicyView(agent.accountAddr, [agent.goal.beneficiary]),
      deps.chain.getBalance(agent.accountAddr),
    ]);
    // Shape = FE AgentDetail (web/lib/types.ts): running|paused|revoked, wei-string
    // policy fields, live balances, addresses, and the blind audit-key blob.
    const status =
      agent.status === 'revoked' || policy.revoked
        ? 'revoked'
        : deps.runtime.isRunning(agent.id)
          ? 'running'
          : 'paused';
    res.json({
      status,
      policy: {
        perTransferCapWei: policy.perTransferCap.toString(),
        windowCapWei: policy.windowCap.toString(),
        windowSeconds: policy.windowSeconds,
        expiresAt: policy.expiresAt,
        allowlist: policy.allowlist,
      },
      accountBalance: accountBalance.toString(),
      sessionExpiry: policy.expiresAt,
      addresses: { account: agent.accountAddr, sessionKey: agent.sessionKeyAddr, owner: agent.ownerAddr },
      ...(agent.encryptedAuditKey !== null ? { encryptedAuditKey: agent.encryptedAuditKey } : {}),
      // Extra context beyond the FE type (tolerated by the client):
      agent: publicAgent(agent),
    });
  }));

  router.get('/api/agents/:id/stream', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    deps.hub.attach(agent.id, res);
  }));

  router.get('/api/agents/:id/traces', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const cursorRaw = req.query['cursor'];
    const limitRaw = req.query['limit'];
    const cursor = Number.parseInt(typeof cursorRaw === 'string' ? cursorRaw : '-1', 10);
    const limit = Math.min(Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10) || 50, 200);
    const records = await listTraces(deps.pool, agent.id, { afterSeq: Number.isNaN(cursor) ? -1 : cursor, limit });
    const verdict = await verifyAgentChainIncremental(deps.pool, agent.id);
    const last = records[records.length - 1];
    res.json({
      records,
      nextCursor: last ? last.seq : null,
      chainVerified: verdict.ok,
    });
  }));

  router.post('/api/approvals/:id', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const approval = await getApproval(deps.pool, req.params['id'] ?? '');
    if (!approval) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    const agent = await getAgentById(deps.pool, approval.agentId);
    if (!agent || agent.ownerAddr !== req.ownerAddr) {
      res.status(403).json({ error: { message: 'forbidden' } });
      return;
    }
    const decided = await decideApproval(deps.pool, approval.id, parsed.data.decision, parsed.data.reason);
    if (!decided) {
      res.status(409).json({ error: { message: 'already decided' } });
      return;
    }
    // The durable consent event is appended HERE, at decision time — strictly
    // BEFORE the broker notify wakes any held request or paused run, which
    // preserves consent-seq < action-seq. The held/resume paths never append
    // (single-append semantics: no double consent record).
    const consent = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'consent',
      approvalId: approval.id,
      decision: parsed.data.decision,
      decidedBy: 'owner',
      originalRequest: approval.requestRef,
      ...(parsed.data.reason !== undefined ? { detail: { reason: parsed.data.reason } } : {}),
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(consent));
    deps.broker.notify(approval.id, {
      decision: parsed.data.decision,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    });
    deps.hub.emit(agent.id, 'approval_decided', {
      type: 'approval_decided',
      approvalId: approval.id,
      decision: parsed.data.decision,
    });
    // Supervised handoff (spec §3b): a delegation-class approval activates (or
    // declines) the envelope — strictly AFTER the consent append above, so
    // consent-seq < delivery on the issuer's chain.
    const ref = approval.requestRef;
    if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref['type'] === 'delegation') {
      const delegationId = ref['delegationId'];
      if (typeof delegationId === 'string') {
        await deps.coordinator.onDelegationApprovalDecision(delegationId, parsed.data.decision);
      }
    }
    res.json({ ok: true, approval: { id: decided.id, state: decided.state } });
  }));

  /** Trace a link config change on BOTH agents (spec §4: link authz is owner-audited). */
  async function traceLinkConfig(link: Link, summary: string): Promise<void> {
    for (const agentId of [link.fromAgentId, link.toAgentId]) {
      const rec = await appendTrace(deps.pool, {
        agentId,
        kind: 'config',
        detail: {
          summary,
          change: 'link',
          linkId: link.id,
          fromAgentId: link.fromAgentId,
          toAgentId: link.toAgentId,
          mode: link.mode,
          status: link.status,
        },
      });
      deps.hub.emit(agentId, 'trace', traceEvent(rec));
    }
  }

  // Links are the ONLY authorization for delegation (spec §3b): same-owner
  // both sides, directed, unique per (from,to), pausable/removable.
  router.post('/api/links', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = linkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const { fromAgentId, toAgentId, mode } = parsed.data;
    if (fromAgentId === toAgentId) {
      // Surfaced here instead of via the DB CHECK — clean 403 per spec §4.
      res.status(403).json({ error: { message: 'self-link not allowed' } });
      return;
    }
    const [from, to] = await Promise.all([getAgentById(deps.pool, fromAgentId), getAgentById(deps.pool, toAgentId)]);
    if (!from || !to) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    if (from.ownerAddr !== req.ownerAddr || to.ownerAddr !== req.ownerAddr) {
      // Cross-owner linking is the lateral-movement primitive — hard 403 (spec §6).
      res.status(403).json({ error: { message: 'forbidden' } });
      return;
    }
    try {
      const link = await createLink(deps.pool, { ownerAddr: req.ownerAddr, fromAgentId, toAgentId, mode });
      await traceLinkConfig(link, `link created: ${from.name} → ${to.name} (${mode})`);
      res.status(201).json({ link });
    } catch (err) {
      if (err instanceof DuplicateLinkError) {
        res.status(409).json({ error: { message: 'link already exists' } });
        return;
      }
      throw err;
    }
  }));

  router.get('/api/links', asyncRoute(async (req: OwnerRequest, res) => {
    const links = await listLinksByOwner(deps.pool, req.ownerAddr as string);
    res.json({ links });
  }));

  // { action: pause|resume|remove } XOR { mode } (spec §4). pause/remove kill
  // the channel: pending/pending_approval envelopes are cancelled; accepted
  // (in-flight) ones run to completion (spec §4 NOTE).
  router.post('/api/links/:id', asyncRoute(async (req: OwnerRequest, res) => {
    const link = await getLink(deps.pool, req.params['id'] ?? '');
    if (!link) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    if (link.ownerAddr !== req.ownerAddr) {
      res.status(403).json({ error: { message: 'forbidden' } });
      return;
    }
    const parsed = linkUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    if (link.status === 'removed') {
      // Removed = terminal (spec §4): a dead channel cannot be resumed,
      // re-moded, or re-paused — create a new link instead.
      res.status(409).json({ error: { message: 'link is removed' } });
      return;
    }
    let updated: Link | null;
    let summary: string;
    if ('mode' in parsed.data) {
      updated = await setLinkMode(deps.pool, link.id, parsed.data.mode);
      summary = `link mode changed to ${parsed.data.mode}`;
    } else if (parsed.data.action === 'pause') {
      updated = await setLinkStatus(deps.pool, link.id, 'paused');
      await deps.coordinator.cancelForLink(link.id, 'link paused by owner');
      summary = 'link paused by owner';
    } else if (parsed.data.action === 'resume') {
      updated = await setLinkStatus(deps.pool, link.id, 'active');
      summary = 'link resumed by owner';
    } else {
      updated = await setLinkStatus(deps.pool, link.id, 'removed');
      await deps.coordinator.cancelForLink(link.id, 'link removed by owner');
      summary = 'link removed by owner';
    }
    if (!updated) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    await traceLinkConfig(updated, summary);
    res.json({ link: updated });
  }));

  // Owner-scoped delegation feed (spec §4): filter by agent OR link — the
  // filter target itself is the authz anchor (must be the owner's).
  router.get('/api/delegations', asyncRoute(async (req: OwnerRequest, res) => {
    const agentIdRaw = req.query['agentId'];
    const linkIdRaw = req.query['linkId'];
    const cursorRaw = req.query['cursor'];
    const agentId = typeof agentIdRaw === 'string' ? agentIdRaw : undefined;
    const linkId = typeof linkIdRaw === 'string' ? linkIdRaw : undefined;
    if (agentId === undefined && linkId === undefined) {
      res.status(400).json({ error: { message: 'agentId or linkId required' } });
      return;
    }
    if (agentId !== undefined) {
      const agent = await getAgentById(deps.pool, agentId);
      if (!agent) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      if (agent.ownerAddr !== req.ownerAddr) {
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }
    }
    if (linkId !== undefined) {
      const link = await getLink(deps.pool, linkId);
      if (!link) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      if (link.ownerAddr !== req.ownerAddr) {
        res.status(403).json({ error: { message: 'forbidden' } });
        return;
      }
    }
    const { delegations, nextCursor } = await listDelegations(deps.pool, {
      ...(agentId !== undefined ? { agentId } : {}),
      ...(linkId !== undefined ? { linkId } : {}),
      ...(typeof cursorRaw === 'string' ? { cursor: cursorRaw } : {}),
    });
    res.json({ delegations, ...(nextCursor !== undefined ? { nextCursor } : {}) });
  }));

  // Pair/batch revoke (spec §4): per-agent guardian-lane revoke + full
  // fan-out. ALL ids must be the owner's or the WHOLE request 403s (nothing
  // revoked); per-agent results stay honest on partial failure (C-2).
  router.post('/api/agents/revoke-batch', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = revokeBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const loaded = await Promise.all(parsed.data.agentIds.map((id) => getAgentById(deps.pool, id)));
    if (loaded.some((a) => !a || a.ownerAddr !== req.ownerAddr)) {
      res.status(403).json({ error: { message: 'forbidden' } });
      return;
    }
    const agents = loaded as AgentRow[];
    const results: Json[] = [];
    for (const agent of agents) {
      // Re-read per iteration: a duplicated id in the batch must go down the
      // idempotent already-revoked path on its second pass.
      const fresh = (await getAgentById(deps.pool, agent.id)) ?? agent;
      if (fresh.status === 'revoked') {
        results.push({ agentId: fresh.id, ok: true, alreadyRevoked: true });
        continue;
      }
      try {
        const { txHash } = await deps.chain.revoke(fresh.accountAddr, fresh.guardianAddr);
        await applyRevokeFanout(
          { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator },
          fresh.id,
          'guardian-api',
        );
        results.push({ agentId: fresh.id, ok: true, txHash });
      } catch (err) {
        // C-2 semantics, per agent: NOT marked revoked (hard boundary still
        // armed), runtime halted anyway, failure chain-visible, owner steered
        // to the LEASH-independent wallet revoke.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`guardian batch revoke failed for agent ${fresh.id}`, err);
        await deps.runtime.haltForRevoke(fresh.id);
        const rec = await appendTrace(deps.pool, {
          agentId: fresh.id,
          kind: 'error',
          detail: { summary: 'guardian revoke failed — agent NOT revoked on-chain', message },
        });
        deps.hub.emit(fresh.id, 'trace', traceEvent(rec));
        results.push({
          agentId: fresh.id,
          ok: false,
          error: 'guardian_revoke_failed',
          ownerRevokeFallback: {
            accountAddr: fresh.accountAddr,
            method: 'revoke()',
            hint: 'Revoke directly from your owner wallet — it works even if LEASH is down.',
          },
        });
      }
    }
    res.json({ results });
  }));

  router.post('/api/agents/:id/rotate', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const token = generateGatewayToken();
    await rotateAgentToken(
      deps.pool,
      agent.id,
      token.tokenId,
      await hashTokenSecret(token.secret),
      encryptSecret(token.token, deps.settings.keyEncryptionSecret),
    );
    res.json({ gatewayToken: token.token }); // returned once; old token is now invalid
  }));

  router.get('/api/agents/:id/audit', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const rows = await deps.pool.query<{
      batch_id: string;
      seq_from: string;
      seq_to: string;
      merkle_root: string;
      storage_tx: string;
      created_at: Date;
    }>(`SELECT * FROM audit_batches WHERE agent_id = $1 ORDER BY seq_from ASC`, [agent.id]);
    const indexer = deps.settings.storageIndexerUrl.replace(/\/$/, '');
    const batches: Array<AuditBatch & { ciphertextUrl: string }> = rows.rows.map((r) => ({
      batchId: r.batch_id,
      agentId: agent.id,
      seqFrom: Number(r.seq_from),
      seqTo: Number(r.seq_to),
      merkleRoot: r.merkle_root,
      storageTx: r.storage_tx,
      createdAt: r.created_at.toISOString(),
      // Public 0G Storage gateway download (ciphertext only — safe to expose).
      ciphertextUrl: `${indexer}/file?root=${r.merkle_root}`,
    }));
    // Shape = FE getAudit: a bare AuditBatch[] (web/lib/api.ts).
    res.json(batches);
  }));

  router.post('/api/agents/:id/start', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (agent.status !== 'active') {
      res.status(409).json({ error: { message: 'agent is revoked' } });
      return;
    }
    await deps.runtime.start(agent.id);
    deps.hub.emit(agent.id, 'status', statusEvent('running'));
    res.json({ ok: true, running: true });
  }));

  router.post('/api/agents/:id/stop', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    await deps.runtime.stop(agent.id);
    deps.hub.emit(agent.id, 'status', statusEvent('paused'));
    res.json({ ok: true, running: false });
  }));

  // Guardian revoke path: instant, no wallet ceremony mid-incident. The
  // guardian key can only refuse (revoke), never spend — non-custodial
  // invariant. Lane selection by the account's stored guardian (C-1/S7).
  router.post('/api/agents/:id/revoke', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    try {
      const { txHash } = await deps.chain.revoke(agent.accountAddr, agent.guardianAddr);
      await applyRevokeFanout(
        { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator },
        agent.id,
        'guardian-api',
      );
      res.json({ ok: true, txHash, status: 'revoked' });
    } catch (err) {
      // C-2: a reverted/failed guardian revoke is NEVER reported ok and the
      // agent is NOT marked revoked (the hard boundary is still armed).
      // Defense-in-depth: halt the runtime anyway, trace the failure, steer
      // the owner to the LEASH-independent wallet revoke (00 §6b).
      const message = err instanceof Error ? err.message : String(err);
      console.error(`guardian revoke failed for agent ${agent.id}`, err);
      await deps.runtime.haltForRevoke(agent.id);
      const rec = await appendTrace(deps.pool, {
        agentId: agent.id,
        kind: 'error',
        detail: { summary: 'guardian revoke failed — agent NOT revoked on-chain', message },
      });
      deps.hub.emit(agent.id, 'trace', traceEvent(rec));
      res.status(502).json({
        ok: false,
        error: 'guardian_revoke_failed',
        ownerRevokeFallback: {
          accountAddr: agent.accountAddr,
          method: 'revoke()',
          hint: 'Revoke directly from your owner wallet — it works even if LEASH is down.',
        },
      });
    }
  }));

  return router;
}

function publicAgent(agent: AgentRow): Record<string, unknown> {
  // never expose token hash or encrypted key material
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    ownerAddr: agent.ownerAddr,
    accountAddr: agent.accountAddr,
    sessionKeyAddr: agent.sessionKeyAddr,
    chainAgentId: agent.chainAgentId,
    auditPubKey: agent.auditPubkey,
    goal: agent.goal,
    gatewayRules: agent.gatewayRules,
    createdAt: agent.createdAt,
  };
}

type Handler = (req: Request, res: Response) => Promise<void>;

function asyncRoute(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
