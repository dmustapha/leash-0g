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
import { getAgentById, insertAgent, rotateAgentToken } from '../store/agents.js';
import { getApproval, decideApproval } from '../store/approvals.js';
import { applyRevokeFanout } from '../agents/revoke-fanout.js';
import type { AgentRow, AuditBatch } from '../types.js';
import type { ChainOps, RuntimeManager, Settings } from '../server.js';

export interface OwnerApiDeps {
  pool: Pool;
  privy: PrivyVerifier;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: ChainOps;
  runtime: RuntimeManager;
  settings: Settings;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const weiSchema = z.string().regex(/^[0-9]{1,30}$/);

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
  gatewayRules: z
    .array(
      z.object({
        action: z.enum(['block', 'modify', 'require_approval']),
        match: z.string().min(1),
        replacement: z.string().optional(),
      }),
    )
    .optional(),
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
    res.json({ ok: true, approval: { id: decided.id, state: decided.state } });
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

  // Guardian revoke path: instant, no wallet ceremony mid-incident. The ops
  // key can only refuse (revoke), never spend — non-custodial invariant.
  router.post('/api/agents/:id/revoke', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const { txHash } = await deps.chain.revoke(agent.accountAddr);
    await applyRevokeFanout({ pool: deps.pool, hub: deps.hub, runtime: deps.runtime }, agent.id, 'guardian-api');
    res.json({ ok: true, txHash, status: 'revoked' });
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
