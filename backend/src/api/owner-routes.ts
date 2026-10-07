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
import { isValidEciesPubkey } from '../crypto/ecies.js';
import { appendTrace, listTraces, verifyAgentChainIncremental } from '../trace/trace-store.js';
import {
  getAgentById,
  insertAgent,
  rotateAgentToken,
  updateAgentGuardian,
  listAgentsByOwner,
  updateAgentRules,
} from '../store/agents.js';
import { reserveCreate, releaseReservation } from '../store/reservations.js';
import type { AlertService } from '../alerts/service.js';
import { listAlerts, getAlert as getAlertRow, markAlertRead, markAllInfoRead, countUnread } from '../alerts/store.js';
import { listOwnerRecords, verifyOwnerChainIncremental } from '../store/owner-records.js';
import { listJobsForOwner, getJob } from '../store/jobs.js';
import { upsertJobSpec, getJobSpec, listJobSpecs } from '../store/job-specs.js';
import { elevateIntent } from '../create/elevation.js';
import { elevateDirection } from '../direction/direction.js';
import { answerStatus } from '../direction/status.js';
import { applyGoalPatch, applyRecipient, validateAcceptancePatch, type GoalPatch } from '../direction/goal-schema.js';
import { insertDirectionDraft, getDirection, confirmDirection } from '../store/directions.js';
import { checkGlobalLlmRate } from '../store/llm-rate.js';
import type { ComputeQueue } from '../gateway/compute-queue.js';
import { jobSpecSchema } from '../jobs/envelopes.js';
import { acceptanceRuleSetSchema } from '../jobs/acceptance.js';
import {
  getOwnerSettings,
  patchOwnerSettings,
  StreamKeyAlreadySetError,
} from '../store/owner-settings.js';
import { getApproval } from '../store/approvals.js';
import { decideApprovalWithConsent } from '../approvals/decide.js';
import {
  resolvePreset,
  recordPresetGrants,
  decideCapabilityRequest,
  type CapabilityDeps,
} from '../capabilities/service.js';
import {
  listGrants,
  listAppliedPresets,
  listRecentRequests,
  upsertGrant,
  setGrantStatus,
  getCapabilityRequest,
} from '../store/capabilities.js';
import { presetKeys, type CallRule, type PresetKey, type TargetCatalog } from '../governed-call/index.js';
import {
  decideToolRequest,
  recordToolPresetGrants,
  type ToolServiceDeps,
} from '../tool-use/tool-service.js';
import {
  expandToolPreset,
  toolPresetKeys,
  defaultToolRegistry,
  type ToolPresetKey,
  type ToolRule,
} from '../tool-use/index.js';
import {
  listToolRules,
  upsertToolRule,
  setToolRuleStatus,
  listAppliedToolPresets,
  listRecentToolRequests,
  getToolRequest,
} from '../store/tools.js';
import { decideSigningRequest, type SigningServiceDeps } from '../signing/signing-service.js';
import {
  defaultSigningRegistry,
  assertDescriptor,
  onChainGrantParams,
  DescriptorError,
  type SigningRule as SigningRuleType,
} from '../signing/index.js';
import {
  upsertSigningRule,
  setSigningRuleStatus,
  listSigningRules,
  listRecentSigningRequests,
  listSigningArms,
  getSigningRequest,
  reconcileSigningArmsByDescriptor,
} from '../store/signing.js';
import { applyRevokeFanout } from '../agents/revoke-fanout.js';
import {
  createLink,
  getLink,
  listLinksByOwner,
  setLinkMode,
  setLinkStatus,
  listDelegations,
  listChainHopDelegations,
  DuplicateLinkError,
} from '../coordination/store.js';
import type { DelegationCoordinator } from '../coordination/coordinator.js';
import { validateChainPlan, terminateOriginChainsForWindDown } from '../coordination/chain.js';
import { insertPlannedChain, getChain, listChainsByOwner } from '../store/chains.js';
import type { ChainStep } from '../types.js';
import type { TelegramBot } from '../telegram/bot.js';
import type { DigestService } from '../digest/service.js';
import type { AgentRow, AuditBatch, Link } from '../types.js';
import { goalAllowlistCandidates, goalRole, assertNativeAgent } from '../types.js';
import type { Json } from '../crypto/canonical.js';
import type { ChainOps, RuntimeManager, Settings } from '../server.js';
import { onboardAgentToChain, OnboardRefusedError, type OnboardChainOps } from '../chain/onboard.js';
import { UnregisteredChainError } from '../chain/registry.js';
import { listChainDeployments, getOwnedAgentIdByDeployment } from '../store/chain-deployments.js';
import { getAgentByAccountAndChain, countAgentsByOwner } from '../store/agents.js';
import { getBoundAgent, updateBoundTokenHash } from '../store/bound-agents.js';
import { bindExternalAgent, BindRefusedError } from '../binding/bind-external.js';
import { listRequestsByChainAndAccount } from '../store/capabilities.js';

/** SE-7: the registry surface the owner routes need (structural — tests fake it). */
export interface OwnerChainRegistry {
  has(chainId: number): boolean;
  listChains(): Array<{
    chainId: number;
    name: string;
    capabilityFactories?: Readonly<Record<string, string>> | undefined;
    // FR4 (F-9): canonical per-chain addresses (band-arm target = canonical.router).
    canonical?: { router?: string | undefined } | undefined;
  }>;
  getChainOps(chainId: number): OnboardChainOps;
  /** RH2 (two-factory): resolve a NAMED wall-capability factory for a chain, or undefined. */
  getCapabilityFactory?(chainId: number, capability: string): string | undefined;
  /** RH2 (two-factory): ops lane for a configured capability factory (default-deny otherwise). */
  getChainOpsForFactory?(chainId: number, factoryV4Addr: string): OnboardChainOps;
  /** SE-8 (carry #2): the grant surface reads the chain's protocol/bridge allowlists. */
  getChainConfig(chainId: number): {
    protocolAllowlist?: readonly string[] | undefined;
    bridgeAllowlist?: readonly string[] | undefined;
    canonical?: { router?: string | undefined; vault?: string | undefined; settlementToken?: string | undefined } | undefined;
    /** F-2: per-chain session-key gas dust override (unset ⇒ global default). */
    sessionGasDustWei?: bigint | undefined;
  };
}

export interface OwnerApiDeps {
  pool: Pool;
  privy: PrivyVerifier;
  /** Phase-5: 0G Compute queue for LEASH-side spec-elevation (D-B1). */
  queue: ComputeQueue;
  hub: SseHub;
  broker: ApprovalBroker;
  chain: ChainOps;
  runtime: RuntimeManager;
  coordinator: DelegationCoordinator;
  alerts: AlertService;
  digest: DigestService;
  /** Present only when the Telegram bot is configured (S9). */
  telegram?: TelegramBot | undefined;
  settings: Settings;
  /**
   * SE-7: multichain registry surface (chain list + second-chain onboarding).
   * Optional so single-chain apps still build; chain routes respond legibly
   * (503 multichain_unavailable) when absent.
   */
  chainRegistry?: OwnerChainRegistry | undefined;
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

// SF-2: external Tier-2 bind body. Minimal by design (§1.2) — LEASH generates
// the token/tenant/endpoints. interaction_mode defaults to 'observe'; the enum
// carries passive/active so the UI can declare them, but bind-external refuses
// to mint a non-observe bind (behavior deferred to SF-2′).
const bindExternalSchema = z.object({
  name: z.string().min(1).max(128),
  interactionMode: z.enum(['observe', 'passive', 'active']).optional(),
  toolAllowlist: z.array(z.string().min(1).max(128)).max(64).optional(),
  leashedAccountAddr: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  chainId: z.number().int().positive().optional(),
  baseUrl: z.string().url().max(2048).optional(),
}).refine((d) => d.leashedAccountAddr === undefined || d.chainId !== undefined, {
  message: 'chainId is required when leashedAccountAddr is provided',
  path: ['chainId'],
});

// Role/goal union (spec §3b): the discriminator is interpreted ONLY by the
// runtime layer — this schema just admits the three shapes. Phase-1 FE bodies
// carry NO `type` and must keep working unchanged, so `treasury` (with its
// optional literal) goes LAST in the union; the explicit literals reject
// mismatched types, so ordering is safe.
const treasuryGoalSchema = z.object({
  type: z.literal('treasury').optional(),
  beneficiary: addressSchema,
  targetBalanceWei: weiSchema,
  topUpWei: weiSchema,
  model: z.string().min(1).optional(),
});

const sentinelGoalSchema = z.object({
  type: z.literal('sentinel'),
  beneficiary: addressSchema,
  targetBalanceWei: weiSchema,
  topUpWei: weiSchema,
  model: z.string().min(1).optional(),
});

const executorGoalSchema = z.object({
  type: z.literal('executor'),
  model: z.string().min(1).optional(),
});

// FR3 (F-8): the trader — autonomous governed-swap role. Token addresses are
// OWNER-TYPED here at create (never model text, never chat-patchable); the
// decide loop's per-trade spend is bounded by clipWei, the call-rule caps +
// spend budget on-chain, and the band wall regardless.
const traderGoalSchema = z.object({
  type: z.literal('trader'),
  holdToken: addressSchema,
  spendToken: addressSchema,
  targetHoldWei: weiSchema,
  clipWei: weiSchema,
  model: z.string().min(1).optional(),
});

// Phase-4 ACP roles (spec §3b). Requester is the sole governed spender; provider
// and evaluator are spend-incapable. jobSpecSource/rubricRef are opaque server
// handles; the fee amount is NEVER trusted from these — it comes from the
// owner-defined job spec in server state (F4).
const requesterGoalSchema = z.object({
  type: z.literal('requester'),
  jobSpecSource: z.string().min(1).max(200),
  providerAgentId: z.string().uuid(),
  evaluatorAgentId: z.string().uuid(),
  feeToken: addressSchema,
  feeRecipient: addressSchema,
  feeCapPerJobWei: weiSchema,
  model: z.string().min(1).optional(),
});

const providerGoalSchema = z.object({
  type: z.literal('provider'),
  serviceSpec: z.string().min(1).max(2000),
  model: z.string().min(1).optional(),
});

const evaluatorGoalSchema = z.object({
  type: z.literal('evaluator'),
  rubricRef: z.string().min(1).max(200),
  model: z.string().min(1).optional(),
});

const goalSchema = z.union([
  sentinelGoalSchema,
  executorGoalSchema,
  traderGoalSchema,
  requesterGoalSchema,
  providerGoalSchema,
  evaluatorGoalSchema,
  treasuryGoalSchema,
]);

// Optional per-account settlement-token config (spec §4). Present ONLY for a
// requester (the sole token-capable role, F1); its token is immutable at create
// (F3). Absent ⇒ native-only account (every other role + legacy shapes).
const tokenConfigSchema = z.object({
  settlementToken: addressSchema,
  perTransferCapTokenWei: weiSchema,
  windowCapTokenWei: weiSchema,
});

/**
 * F-2: recognize an ops-wallet balance failure anywhere in a viem error chain.
 * Exported for unit tests. viem's InsufficientFundsError text ("insufficient
 * funds for gas * price + value") and common node phrasings are both matched;
 * anything else keeps the opaque-500 path (no detail leaks, M-01). Scope: only
 * called around OPS-WALLET sends (deploy/register/dust) — never around calls
 * whose revert strings user input could shape (e.g. token transfers).
 */
export function isInsufficientFunds(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur instanceof Error; depth++) {
    const text = `${cur.name} ${cur.message} ${(cur as { details?: string }).details ?? ''}`;
    if (/insufficient funds|insufficient balance|InsufficientFundsError/i.test(text)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// Exported for unit tests (create-input hardening: past expiry, zero-address allowlist).
export const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  auditPubKey: z
    .string()
    .regex(/^(0x)?0[23][0-9a-fA-F]{64}$|^(0x)?04[0-9a-fA-F]{128}$/)
    // F-3: the regex pins the SHAPE only — a well-shaped blob that is not a
    // point on secp256k1 would poison every later audit flush ("bad point:
    // is not on curve"). Reject it at the door.
    .refine(isValidEciesPubkey, { message: 'auditPubKey is not a valid secp256k1 point' }),
  policy: z.object({
    perTransferCapWei: weiSchema,
    windowCapWei: weiSchema,
    windowSeconds: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  }),
  // min(1) enforced per role below: the spend-incapable sentinel preset and
  // the inbound-driven executor legitimately create with an EMPTY allowlist
  // (spec §3c) — treasury keeps the Phase-1 requirement unchanged.
  allowlist: z.array(addressSchema),
  goal: goalSchema,
  gatewayRules: z.array(gatewayRuleSchema).optional(),
  /** Opaque KEK-wrapped audit privkey blob, encrypted in the owner's browser. */
  encryptedAuditKey: z.string().min(1).max(20_000).optional(),
  /** Phase-4: settlement-token config — required for requester, forbidden otherwise. */
  tokenConfig: tokenConfigSchema.optional(),
  /** Phase-5 (D-B9): optional freeform capability label (elevation-suggested, owner-edited). Inert. */
  capabilityLabel: z.string().max(120).optional(),
  /**
   * SE-1 (Stage E, SD-E7): on-chain account version. Default 4 — new agents are
   * governed-calldata V4 accounts (the product-standard; V4 is a strict superset
   * of the v3 settlement path). `2` pins the legacy factory (E-1 regression).
   * Coerced from JSON number; only 2 | 4 accepted.
   */
  accountVersion: z.union([z.literal(2), z.literal(4)]).default(4),
  /**
   * SE-7 (spec §7.C "chain choice collected at create"): which registered
   * chain the agent's account is minted on. Default = the home 0G chain.
   * Validated against the ChainRegistry at the route (default-deny, E-11).
   */
  chainId: z.number().int().positive().optional(),
  /**
   * RH2 (two-factory): mint through a NAMED secondary wall-capability factory on
   * the target chain (e.g. `oracleBand` → the price-band wall). A KEY, never an
   * address — resolved to an operator-configured factory at the route, else 409.
   */
  capability: z.string().min(1).max(32).optional(),
  /**
   * F-5: agents are not born paused. Spend-incapable roles (sentinel/provider/
   * evaluator) start their runtime loop right after create — they can never
   * move money, so there is nothing to fund first. Spend-capable roles stay
   * paused until funded (the FE starts them on funding success). `false` opts
   * an API caller out entirely.
   */
  autoStart: z.boolean().default(true),
}).superRefine((v, issues) => {
  const role = v.goal.type ?? 'treasury';
  if (role === 'treasury' && v.allowlist.length < 1) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'allowlist must not be empty for a treasury agent',
      path: ['allowlist'],
    });
  }
  // Phase-4 requester: token-capable, the sole governed spender (F1).
  if (v.goal.type === 'requester') {
    if (!v.tokenConfig) {
      issues.addIssue({ code: z.ZodIssueCode.custom, message: 'requester requires tokenConfig', path: ['tokenConfig'] });
    } else {
      // feeToken must match the account's settlement token (single token, F3).
      if (v.tokenConfig.settlementToken.toLowerCase() !== v.goal.feeToken.toLowerCase()) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: 'goal.feeToken must equal tokenConfig.settlementToken', path: ['goal', 'feeToken'] });
      }
      // feeCapPerJob ≤ on-chain per-token per-transfer cap (defence in depth, F4).
      if (BigInt(v.goal.feeCapPerJobWei) > BigInt(v.tokenConfig.perTransferCapTokenWei)) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: 'goal.feeCapPerJobWei must not exceed tokenConfig.perTransferCapTokenWei', path: ['goal', 'feeCapPerJobWei'] });
      }
      // The fee recipient must be on the account allowlist (the contract enforces it too).
      if (!v.allowlist.map((a) => a.toLowerCase()).includes(v.goal.feeRecipient.toLowerCase())) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: 'goal.feeRecipient must be in the allowlist', path: ['goal', 'feeRecipient'] });
      }
    }
  } else if (v.tokenConfig) {
    // Only a requester may configure a settlement token (F1) — provider/
    // evaluator/treasury/sentinel/executor are native-only.
    issues.addIssue({ code: z.ZodIssueCode.custom, message: 'tokenConfig is only valid for a requester goal', path: ['tokenConfig'] });
  }
  // Provider/evaluator are spend-incapable (like sentinel): zero native caps.
  // Evaluator may have an empty allowlist (like sentinel); provider too.
  if ((role === 'provider' || role === 'evaluator') &&
    (BigInt(v.policy.perTransferCapWei) !== 0n || BigInt(v.policy.windowCapWei) !== 0n)) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: `${role} must be spend-incapable (zero native caps)`, path: ['policy'] });
  }
  // FE validates this too, but the API is the enforcement boundary: a top-up
  // chunk above the per-transfer cap would push every cycle into approval.
  // TREASURY ONLY (spec §3c): the sentinel ships the spend-incapable preset
  // (perTransferCap 0) with a meaningful topUpWei — the amount it ASKS the
  // executor to send. The sentinel never spends, so its own cap does not
  // bound its request size; the executor goal has no beneficiary/amounts.
  if (role === 'treasury' && 'topUpWei' in v.goal && BigInt(v.goal.topUpWei) > BigInt(v.policy.perTransferCapWei)) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'goal.topUpWei must not exceed policy.perTransferCapWei',
      path: ['goal', 'topUpWei'],
    });
  }
  // FR3 (F-8): a trader must trade BETWEEN two distinct tokens, and spends only
  // via governed calls — no native allowlist target is required (unlike treasury).
  if (v.goal.type === 'trader' && v.goal.holdToken.toLowerCase() === v.goal.spendToken.toLowerCase()) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'goal.holdToken and goal.spendToken must differ',
      path: ['goal', 'holdToken'],
    });
  }
  // A past expiry would mint a born-dead account (expired on-chain from its
  // first block) and burn the deploy gas for nothing.
  if (v.policy.expiresAt <= Math.floor(Date.now() / 1000)) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'policy.expiresAt must be in the future',
      path: ['policy', 'expiresAt'],
    });
  }
  // The zero address is never a valid recipient; it reverts deep in the deploy
  // path and surfaces as an opaque 500.
  if (v.allowlist.some((a) => /^0x0{40}$/.test(a))) {
    issues.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'allowlist must not contain the zero address',
      path: ['allowlist'],
    });
  }
});

const decisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  reason: z.string().max(500).optional(),
});

// Stage D (spec §4) — governed-calldata grant surfaces. A rule mirrors the
// on-chain CallRule; caps are base-units decimal strings; the owner signs the
// on-chain tx client-side (Privy), reporting its hash back to record the
// read-model (the backend never holds owner authority / never submits it).
const callRuleSchema = z.object({
  target: addressSchema,
  selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
  recipientMode: z.enum(['self', 'allowlist']),
  spenderSet: z.array(addressSchema).max(16).default([]),
  perCallCap: weiSchema,
  windowCapCall: weiSchema,
  codehash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
const presetApplySchema = z.object({
  presetKey: z.string().min(1).max(40),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
const capabilityRuleSchema = z.object({
  // FR3 (F-8c): 'apply' — the owner signed applyCallRule for a matured proposed
  // rule; flips the read-model grant proposed→active (on-chain stays authoritative).
  action: z.enum(['propose', 'tighten', 'remove', 'apply']),
  rule: callRuleSchema,
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
const capabilityDecisionSchema = z.object({
  decision: z.enum(['approve_once', 'always_allow', 'deny']),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  rule: callRuleSchema.optional(),
});

// SF-3 (STAGE-F §4) — governed tool-use grant surfaces. A tool rule mirrors a
// `ToolRule`; the decision rides the SAME `POST /api/approvals/:id` rail as the
// Stage-D capability JIT, branched on `requestRef.type === 'tool'`. Fully
// off-chain (no tx) — the owner's consent IS the authority for the call.
const toolPerCallPolicySchema = z.object({
  maxArgBytes: z.number().int().positive().max(1_000_000).optional(),
  recipientAllowlist: z.array(z.string().max(320)).max(64).optional(),
  urlOriginAllowlist: z.array(z.string().max(320)).max(64).optional(),
});
const toolRuleSchema = z.object({
  toolId: z.string().min(1).max(128),
  allowed: z.boolean().default(true),
  sensitive: z.boolean().default(false),
  perCallPolicy: toolPerCallPolicySchema.optional(),
});
const toolPresetApplySchema = z.object({ presetKey: z.string().min(1).max(40) });
const toolRuleApplySchema = z.object({
  action: z.enum(['set', 'remove']),
  rule: toolRuleSchema,
});
const toolDecisionSchema = z.object({ decision: z.enum(['approve_once', 'always_allow', 'deny']) });

// F′ FP-2 (STAGE-F-PRIME §4) — governed-signing grant surfaces. A signing rule
// mirrors a `SigningRule`; the JIT decision rides the SAME `POST /api/approvals/:id`
// rail, branched on `requestRef.type === 'signing'`. The owner's client signs the
// on-chain `proposeSigningGrant` with the engine-computed params; this route
// records the read-model mirror + the reconcile.
const signingRuleSchema = z.object({
  descriptorId: z.number().int().nonnegative(),
  spenderSet: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(64),
  perIntentCap: z.string().regex(/^\d{1,40}$/),
  maxDeadlineWindow: z.number().int().nonnegative().max(31_536_000), // ≤ 1 year
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const signingRuleApplySchema = z.object({
  action: z.enum(['set', 'remove']),
  rule: signingRuleSchema,
});
const signingDecisionSchema = z.object({ decision: z.enum(['approve_once', 'always_allow', 'deny']) });

/** Normalize a validated rule into the CallRule shape (lowercased, no partials). */
function toCallRule(r: z.infer<typeof callRuleSchema>): CallRule {
  return {
    target: r.target.toLowerCase(),
    selector: r.selector.toLowerCase(),
    recipientMode: r.recipientMode,
    spenderSet: r.spenderSet.map((s) => s.toLowerCase()),
    perCallCap: r.perCallCap,
    windowCapCall: r.windowCapCall,
    ...(r.codehash ? { codehash: r.codehash.toLowerCase() } : {}),
  };
}

// Phase-5 (D-B1): spec-elevation input. `intent` is the owner's plain-language
// description; `answers` are optional guided-question answers; `role` is an
// optional hint from a template/manual pick. Length-capped (LLM-spam surface).
const elevateSchema = z.object({
  intent: z.string().min(1).max(2000),
  answers: z.array(z.string().max(1000)).max(10).optional(),
  role: z.enum(['treasury', 'sentinel', 'executor', 'requester', 'provider', 'evaluator']).optional(),
});

// Phase-5.5 direction-time elevation input (own limiter, N-1).
const directSchema = z.object({
  intent: z.string().min(1).max(2000),
  answers: z.array(z.string().max(1000)).max(10).optional(),
  threadId: z.string().max(80).optional(),
});

// Confirm: only the owner-confirmed goalPatch / acceptancePatch are trusted (the
// server re-validates them, R-1); the recipient is owner-typed + out-of-band.
// Other DirectionDraft fields are display-only and ignored for authority.
const directConfirmSchema = z
  .object({
    // Only goalPatch / acceptancePatch are authority-bearing (server re-validated);
    // the rest of the DirectionDraft is display-only, so ignore any extra fields.
    edited: z
      .object({
        goalPatch: z.record(z.unknown()).optional(),
        acceptancePatch: z.array(z.unknown()).optional(),
      })
      .strip(),
    recipient: z.string().max(64).optional(),
    // Phase 5.6 (D-1): an optional owner-authored chain plan riding the SAME
    // confirm. Deep-validated by validateChainPlan (ownership + links + caps +
    // cycle) — here we only bound the outer shape (raw hops stay opaque).
    chainPlan: z.array(z.unknown()).max(16).optional(),
  })
  .strip();

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

  /**
   * Load the agent and enforce owner match; responds 404 itself.
   * Foreign-owned answers 404, NOT 403: a 403 is an enumeration oracle — it
   * confirms to a stranger that the agent ID exists. Real-but-not-yours must
   * be indistinguishable from never-existed (matches the alerts surface).
   */
  async function requireOwnedAgent(req: OwnerRequest, res: Response): Promise<AgentRow | null> {
    const id = req.params['id'] ?? '';
    const agent = await getAgentById(deps.pool, id);
    if (!agent || agent.ownerAddr !== req.ownerAddr) {
      res.status(404).json({ error: { message: 'not found' } });
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
    // Order: cheap shape caps first, then the reservation guard (all before
    // any on-chain spend). Error shapes per PHASE-2 spec §4.
    if (input.allowlist.length > deps.settings.allowlistMax) {
      res.status(400).json({ error: 'allowlist_too_long', max: deps.settings.allowlistMax });
      return;
    }
    if ((input.gatewayRules?.length ?? 0) > deps.settings.rulesMax) {
      res.status(400).json({ error: 'too_many_rules', max: deps.settings.rulesMax });
      return;
    }
    // P3C-3: the sentinel's spend-incapable preset is enforced HERE, not
    // trusted to the FE — a direct API caller must not mint a spend-capable
    // "sentinel" (its role exempts it from the topUp≤cap validation, so a
    // nonzero policy would smuggle real spending power past that check).
    if (
      input.goal.type === 'sentinel' &&
      (BigInt(input.policy.perTransferCapWei) !== 0n ||
        BigInt(input.policy.windowCapWei) !== 0n ||
        input.allowlist.length > 0)
    ) {
      res.status(400).json({ error: 'sentinel_must_be_spend_incapable' });
      return;
    }
    // P3C-1: quota + rate are checked AND reserved atomically under a
    // per-owner advisory lock — a parallel burst can no longer all pass at
    // t=0 while the slow deploys are in flight. Quota still counts revoked
    // rows (07 S6); rate counts in-flight reservations.
    const reserved = await reserveCreate(deps.pool, ownerAddr, {
      quotaPerOwner: deps.settings.createQuotaPerOwner,
      ratePerHour: deps.settings.createRatePerHour,
      reservationTtlMs: deps.settings.reservationTtlMs,
    });
    if (!reserved.ok) {
      if (reserved.reason === 'quota_exceeded') {
        res.status(403).json({ error: 'quota_exceeded', limit: deps.settings.createQuotaPerOwner });
      } else {
        res.setHeader('retry-after', String(reserved.retryAfter));
        res.status(429).json({ error: 'rate_limited', retryAfter: reserved.retryAfter });
      }
      return;
    }

    // The reservation is released on BOTH outcomes (finally below): success —
    // the committed agent row carries the count from then on; failure — the
    // slot frees, a failed deploy never burns quota/rate. TTL sweep besides.
    try {
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
    // SE-7: create-time chain choice — resolve the target chain's ops lane via
    // the registry (default-deny for unregistered chains); absent/default keeps
    // the existing single-chain wire byte-identical.
    const createChainId = input.chainId ?? deps.settings.defaultChainId;
    let createChain = deps.chain;
    if (createChainId !== deps.settings.defaultChainId) {
      if (!deps.chainRegistry || !deps.chainRegistry.has(createChainId)) {
        res.status(409).json({ error: 'unregistered_chain', chainId: createChainId });
        return;
      }
      createChain = deps.chainRegistry.getChainOps(createChainId);
    }
    // RH2 (two-factory): mint through a NAMED secondary wall-capability factory
    // when asked (e.g. `oracleBand`). Default-deny: the capability must be
    // configured for THIS chain, and the default chain has no secondary factories.
    if (input.capability) {
      const capFactory =
        createChainId !== deps.settings.defaultChainId
          ? deps.chainRegistry?.getCapabilityFactory?.(createChainId, input.capability)
          : undefined;
      if (!capFactory || !deps.chainRegistry?.getChainOpsForFactory) {
        res.status(409).json({ error: 'unknown_capability', capability: input.capability, chainId: createChainId });
        return;
      }
      createChain = deps.chainRegistry.getChainOpsForFactory(createChainId, capFactory);
    }
    // F-2: an underfunded OPS wallet is an operator-funding condition, not an
    // "internal error" — surface it as a clear 4xx instead of an opaque 500.
    const opsUnderfunded = (): void => {
      res.status(409).json({
        error: {
          message: `the operator gas wallet on chain ${createChainId} is underfunded — agent creation is temporarily unavailable on this chain`,
          reason: 'ops_wallet_underfunded',
        },
      });
    };
    let deployed;
    try {
      deployed = await createChain.deployAndRegister({
        ownerAddr,
        sessionKeyAddr,
        auditPubKey: input.auditPubKey,
        name: input.name,
        accountVersion: input.accountVersion, // SE-1: 4 (default) → V4 factory; 2 → legacy
        policy: {
          perTransferCap: BigInt(input.policy.perTransferCapWei),
          windowCap: BigInt(input.policy.windowCapWei),
          windowSeconds: input.policy.windowSeconds,
          expiresAt: input.policy.expiresAt,
        },
        allowlist: input.allowlist,
        timelockDelay: deps.settings.defaultTimelockDelay,
        // Phase-4: token-capable ONLY for a requester (validated above); the
        // settlement token is immutable at create (F3).
        ...(input.tokenConfig
          ? {
              settlementToken: input.tokenConfig.settlementToken,
              tokenPolicy: {
                perTransferCapToken: BigInt(input.tokenConfig.perTransferCapTokenWei),
                windowCapToken: BigInt(input.tokenConfig.windowCapTokenWei),
              },
            }
          : {}),
      });
    } catch (err) {
      if (isInsufficientFunds(err)) {
        opsUnderfunded();
        return;
      }
      throw err;
    }

    const token = generateGatewayToken();
    const agentId = await insertAgent(deps.pool, {
      chainAgentId: deployed.chainAgentId,
      chainId: createChainId,
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
      ...(input.capabilityLabel ? { capabilityLabel: input.capabilityLabel } : {}),
      accountVersion: deployed.accountVersion, // SE-1: persist the version actually minted (gate L-01)
      // SE-6: persist the CREATE2 salt + the exact construction tuple actually
      // used (causally from the deploy result, like accountVersion) — replayed
      // verbatim when this agent onboards another chain so the account lands at
      // the SAME address (the tuple is baked into the CREATE2 initcode).
      accountSalt: deployed.accountSalt,
      accountCreateTuple: deployed.accountCreateTuple as Record<string, unknown> | null,
    });

    // The committed agent row carries the quota/rate count from here on —
    // release the reservation NOW, before the response (the finally below is
    // an idempotent safety net for the failure paths).
    await releaseReservation(deps.pool, reserved.reservationId);

    // Gas dust so the session key can pay execute() gas; funds stay behind the
    // account. Funded on the CHAIN the account was minted on (SE-7). F-2: dust
    // is chain-priced — a per-chain override (EXTRA_CHAINS sessionGasDustWei)
    // beats the 0G-sized global default.
    const dustWei =
      (createChainId !== deps.settings.defaultChainId
        ? deps.chainRegistry?.getChainConfig(createChainId).sessionGasDustWei
        : undefined) ?? deps.settings.sessionGasDustWei;
    try {
      await createChain.fundSessionKey(sessionKeyAddr, dustWei);
    } catch (err) {
      // The ops wallet ran dry BETWEEN deploy and dust-funding (narrow, but
      // observed on RH). The agent EXISTS (minted + registered + inserted,
      // quota slot consumed) — a 409 here would orphan it with no agentId
      // returned. Answer 201 with the full create payload + a warning so the
      // owner can fund/retry; the one-shot gatewayToken must not be lost.
      if (isInsufficientFunds(err)) {
        console.error(`agent ${agentId} created but session key unfunded: ops wallet dry on chain ${createChainId}`);
        res.status(201).json({
          agentId,
          accountAddr: deployed.accountAddr,
          sessionKeyAddr,
          chainAgentId: deployed.chainAgentId.toString(),
          gatewayToken: token.token,
          txHashes: [deployed.createTx, deployed.registerTx],
          warning: {
            code: 'session_key_unfunded',
            message: `the operator gas wallet on chain ${createChainId} ran dry before gas-dust funding — the agent was created but its session key has no gas yet`,
          },
        });
        return;
      }
      throw err;
    }

    // F-5: spend-incapable roles go live immediately — an unfunded spender
    // would burn an LLM cycle + error trace every 30s, so treasury/executor/
    // requester wait for the FE's funding-success (or explicit) start.
    const createdRole = input.goal.type ?? 'treasury';
    if (input.autoStart && (createdRole === 'sentinel' || createdRole === 'provider' || createdRole === 'evaluator')) {
      try {
        await deps.runtime.start(agentId);
        deps.hub.emit(agentId, 'status', statusEvent('running'));
      } catch (err) {
        // Create already succeeded — a start hiccup must not fail the response;
        // the owner still has the manual Start CTA.
        // F-6: on a non-holder instance this is RuntimeLeaseNotHeldError — the
        // agent is born active in the DB but unlooped until the holder (or a
        // lease handover) picks it up; the manual Start CTA routes through
        // whichever instance answers then. Known LOW-severity liveness gap.
        console.error(`auto-start failed for agent ${agentId}`, err);
      }
    }

    // Shape = FE CreateAgentResponse (web/lib/types.ts).
    res.status(201).json({
      agentId,
      accountAddr: deployed.accountAddr,
      sessionKeyAddr,
      chainAgentId: deployed.chainAgentId.toString(),
      gatewayToken: token.token, // returned ONCE; only the argon2id hash is stored
      txHashes: [deployed.createTx, deployed.registerTx],
    });
    } finally {
      await releaseReservation(deps.pool, reserved.reservationId).catch((err: unknown) => {
        console.error('reservation release failed', err);
      });
    }
  }));

  // P3C-5: the fleet list's balance fan-out (N live RPC reads per request)
  // is an authed amplification surface — cache per account, short TTL.
  // In-process only (one Render instance; a restart just re-reads). The
  // agent DETAIL view keeps live reads.
  // D-B1 elevate rate limit (LLM-spam vector): a per-owner sliding window,
  // in-process (single Render instance, like balanceCache; a restart just resets
  // — bounding an authed compute-cost surface, not a security control). Reuses
  // the create-rate posture as the ceiling.
  const elevateHits = new Map<string, number[]>();
  function elevateRateOk(ownerAddr: string): boolean {
    const now = Date.now();
    const windowMs = 3_600_000;
    const limit = deps.settings.createRatePerHour;
    const recent = (elevateHits.get(ownerAddr) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      elevateHits.set(ownerAddr, recent);
      return false;
    }
    recent.push(now);
    elevateHits.set(ownerAddr, recent);
    // L-01 hygiene: sweep owners whose window has fully aged out so the map does
    // not grow unbounded with one entry per owner who ever elevated.
    if (elevateHits.size > 1000) {
      for (const [k, v] of elevateHits) {
        if (v.every((t) => now - t >= windowMs)) elevateHits.delete(k);
      }
    }
    return true;
  }

  // N-1 (Phase-5.5): /direct and /status each get their OWN per-owner sliding
  // ceiling, mirroring the elevate limiter — separate from the create limit and
  // from each other (an owner iterating direction drafts or status queries must
  // never trip the create limiter). In-process (single Render instance).
  function makeSlidingLimiter(limit: number): (ownerAddr: string) => boolean {
    const hits = new Map<string, number[]>();
    return (ownerAddr: string): boolean => {
      const now = Date.now();
      const windowMs = 3_600_000;
      const recent = (hits.get(ownerAddr) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(ownerAddr, recent);
        return false;
      }
      recent.push(now);
      hits.set(ownerAddr, recent);
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
      return true;
    };
  }
  const directRateOk = makeSlidingLimiter(deps.settings.createRatePerHour);
  const statusRateOk = makeSlidingLimiter(deps.settings.createRatePerHour);
  // Phase 5.6 (N-1): the chain read-model GETs get their OWN per-owner ceiling
  // (read-only, no LLM — a generous but bounded cap).
  const chainsRateOk = makeSlidingLimiter(deps.settings.createRatePerHour);
  // Stage D: the capability grant/envelope routes get their OWN per-owner ceiling.
  const capabilitiesRateOk = makeSlidingLimiter(deps.settings.createRatePerHour);
  // SF-2 (M-01): the external-bind route mints an argon2id hash per call + inserts
  // rows — a CPU/memory-amplification + unbounded-growth surface if unbounded.
  // Same per-owner ceiling as create.
  const bindRateOk = makeSlidingLimiter(deps.settings.createRatePerHour);
  const capabilityDeps: CapabilityDeps = {
    pool: deps.pool,
    hub: deps.hub,
    broker: deps.broker,
    alerts: deps.alerts,
    jitTtlMs: deps.settings.jitTtlMs,
  };
  // SF-3: the tool-use JIT rail deps (same approval rail, off-chain decisions).
  const toolServiceDeps: ToolServiceDeps = {
    pool: deps.pool,
    hub: deps.hub,
    broker: deps.broker,
    alerts: deps.alerts,
    registry: defaultToolRegistry,
    jitTtlMs: deps.settings.jitTtlMs,
  };
  // F′ FP-2: the governed-signing JIT rail deps (same approval rail, off-chain decisions).
  const signingServiceDeps: SigningServiceDeps = {
    pool: deps.pool,
    hub: deps.hub,
    broker: deps.broker,
    alerts: deps.alerts,
    jitTtlMs: deps.settings.jitTtlMs,
  };

  // H-01 (round-2 red-team): the per-owner limiters above are bypassable by
  // rotating fresh wallet addresses (each new owner gets a fresh bucket), which
  // could drain LEASH's shared 0G Compute key. `globalLlmOk()` is an
  // address-agnostic global hourly ceiling across the owner-triggered LLM surface
  // (elevate + direct + status). It is DURABLE (store/llm-rate.ts): a DB-backed,
  // advisory-lock-serialized counter that survives restarts and holds across
  // instances — closing the address-rotation drain completely.
  const GLOBAL_LLM_PER_HOUR = 500;
  const globalLlmOk = (): Promise<boolean> => checkGlobalLlmRate(deps.pool, GLOBAL_LLM_PER_HOUR);

  /**
   * SE-7 (code-review BLOCKER fix): every on-chain owner op resolves the ops
   * lane for the AGENT'S HOME CHAIN — a Base-home agent's revoke/policy/balance
   * must never land on the default chain's client (a wrong-chain revoke is a
   * successful no-op tx = a kill-switch bypass). Default chain keeps the
   * existing single-client wire; any other chain resolves through the registry
   * (default-deny beyond it) and FAILS LOUDLY when the registry is absent.
   */
  function chainForAgent(a: { chainId: number }): ChainOps {
    if (a.chainId === deps.settings.defaultChainId) return deps.chain;
    if (!deps.chainRegistry) {
      throw new Error(`agent home chain ${a.chainId} requires the multichain registry (not configured)`);
    }
    return deps.chainRegistry.getChainOps(a.chainId);
  }

  /**
   * FR3 (SE-8 carry, F-8a): resolve the preset TargetCatalog from the AGENT'S
   * chain — the registered chain's `canonical` targets — instead of only the
   * global CAP_* env (which describes the default chain). A non-default chain
   * with no canonical config resolves to an empty catalog → resolvePreset
   * answers `unresolvable_target` legibly (default-deny, never the WRONG
   * chain's addresses). The default chain keeps the existing env-built catalog.
   */
  function catalogForAgent(agent: { chainId: number }): TargetCatalog {
    if (agent.chainId === deps.settings.defaultChainId || !deps.chainRegistry) {
      return deps.settings.capabilityCatalog;
    }
    const canonical = deps.chainRegistry.getChainConfig(agent.chainId).canonical;
    return {
      ...(canonical?.router ? { router: canonical.router.toLowerCase() } : {}),
      ...(canonical?.vault ? { vault: canonical.vault.toLowerCase() } : {}),
      ...(canonical?.settlementToken ? { settlement_token: canonical.settlementToken.toLowerCase() } : {}),
    };
  }

  /**
   * SE-8 (SE-7 gate carry #2): when the agent's chain carries an owner-configured
   * `protocolAllowlist`, the grant SURFACE refuses rule/preset targets outside
   * `protocolAllowlist ∪ bridgeAllowlist ∪ canonical` — the config field is
   * consumed, never a dormant spend-gate lookalike. (The on-chain V4 allowlist
   * the owner signs remains the actual spend wall.) Chains with no configured
   * list (0G mocks today) are unrestricted, as before.
   */
  function targetGrantable(agent: { chainId: number }, target: string): boolean {
    if (!deps.chainRegistry) {
      // No registry wired (single-chain test setups): only the default chain is
      // reachable at all, and it has no configured list — unrestricted, as before.
      return agent.chainId === deps.settings.defaultChainId;
    }
    let cfg;
    try {
      cfg = deps.chainRegistry.getChainConfig(agent.chainId);
    } catch {
      return false; // unregistered chain: default-deny
    }
    const protocols = cfg.protocolAllowlist ?? [];
    if (protocols.length === 0) return true; // no configured list on this chain
    const allowed = new Set<string>(
      [
        ...protocols,
        ...(cfg.bridgeAllowlist ?? []),
        cfg.canonical?.router,
        cfg.canonical?.vault,
        cfg.canonical?.settlementToken,
      ]
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.toLowerCase()),
    );
    return allowed.has(target.toLowerCase());
  }

  const balanceCache = new Map<string, { value: bigint; at: number }>();
  async function cachedBalance(addr: string, chainId: number): Promise<bigint> {
    const key = `${chainId}:${addr.toLowerCase()}`;
    const hit = balanceCache.get(key);
    if (hit && Date.now() - hit.at < deps.settings.balanceCacheTtlMs) return hit.value;
    const value = await chainForAgent({ chainId }).getBalance(addr);
    balanceCache.set(key, { value, at: Date.now() });
    return value;
  }

  // Fleet list (spec §4): the authed owner's agents, newest-first, keyset
  // cursor `<createdAtISO>_<id>` (documented choice: created_at DESC with id
  // tiebreak — stable under concurrent creates). Balances are cached reads
  // (P3C-5, TTL above).
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
        // Phase-4: the runtime role, so the create flow can offer provider/
        // evaluator agents to a new requester (generality guard: derived here,
        // never a coordination-table column).
        role: goalRole(a.goal),
        capabilityLabel: a.capabilityLabel,
        // SF-2: surface the bind mode so the fleet UI renders bound agents
        // distinctly (no on-chain account, governed at the gateway only).
        bindMode: a.bindMode,
        accountAddr: a.accountAddr,
        sessionKeyAddr: a.sessionKeyAddr,
        // A bound agent has no on-chain account → no balance to read.
        accountBalanceWei:
          a.accountAddr !== null ? (await cachedBalance(a.accountAddr, a.chainId)).toString() : null,
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
    // SF-2: a bound (external) agent has no on-chain account/policy/balance to
    // read. Its governance lives entirely at the gateway (tool allowlist + the
    // JIT rail); surface the Tier-2 model instead of hitting a chain it has no
    // account on.
    if (agent.bindMode === 'external') {
      const bound = await getBoundAgent(deps.pool, agent.id);
      res.json({
        status: agent.status === 'revoked' ? 'revoked' : deps.runtime.isRunning(agent.id) ? 'running' : 'paused',
        bindMode: 'external',
        bound: bound
          ? {
              interactionMode: bound.interactionMode,
              mcpScope: bound.mcpScope,
              leashedAccountAddr: bound.leashedAccountAddr,
              chainId: bound.chainId,
            }
          : null,
        addresses: { account: agent.accountAddr, sessionKey: agent.sessionKeyAddr, owner: agent.ownerAddr },
        agent: publicAgent(agent),
      });
      return;
    }
    assertNativeAgent(agent); // narrows for the native on-chain reads below
    const [policy, accountBalance] = await Promise.all([
      // Role-aware allowlist candidate (spec §3b): treasury/sentinel =
      // beneficiary, requester = fee recipient, executor/provider/evaluator =
      // none. The view still returns caps/expiry/revoked regardless.
      chainForAgent(agent).getPolicyView(agent.accountAddr, goalAllowlistCandidates(agent.goal)),
      chainForAgent(agent).getBalance(agent.accountAddr),
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
      // M-03: the guardian LEASH revokes with — the FE warns when the live
      // on-chain guardian no longer matches (one-click revoke unavailable).
      leashGuardianAddr: agent.guardianAddr,
      ...(agent.encryptedAuditKey !== null ? { encryptedAuditKey: agent.encryptedAuditKey } : {}),
      // Extra context beyond the FE type (tolerated by the client):
      agent: publicAgent(agent),
    });
  }));

  router.get('/api/agents/:id/stream', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    // P4C-1: pass ownerAddr so this per-agent stream counts toward the owner's
    // connection cap (rejection sends a 429 before the SSE head).
    deps.hub.attach(agent.id, res, agent.ownerAddr);
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
    // Fetch + owner-check FIRST so we can branch on the approval TYPE: a Stage-D
    // capability (JIT) decision carries a richer body (approve_once/always_allow/
    // deny + the owner-signed tx) than the approve/deny consent used by
    // delegation/gateway approvals — they must not share one schema.
    const approval = await getApproval(deps.pool, req.params['id'] ?? '');
    if (!approval) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    const agent = await getAgentById(deps.pool, approval.agentId);
    if (!agent || agent.ownerAddr !== req.ownerAddr) {
      // 404, not 403 — same enumeration-oracle rule as requireOwnedAgent.
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    const ref = approval.requestRef;
    const refType =
      ref !== null && typeof ref === 'object' && !Array.isArray(ref) ? ref['type'] : undefined;

    // SF-3: a tool JIT decision (off-chain) — approve-once / always-allow / deny.
    if (refType === 'tool') {
      const parsedTool = toolDecisionSchema.safeParse(req.body);
      if (!parsedTool.success) {
        res.status(400).json({ error: { message: 'invalid request body' } });
        return;
      }
      const requestId = (ref as Record<string, unknown>)['requestId'];
      const request = typeof requestId === 'string' ? await getToolRequest(deps.pool, requestId) : null;
      if (!request) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      // C-SF3-2: `agent` is resolved from the approval; `request` is fetched by
      // id independently. Assert they belong to the SAME agent before deciding,
      // or a crafted (approvalId, requestId) pair could decide a tool request
      // that rides a different agent's grant. 404 (not 403) — same enumeration-
      // oracle discipline as requireOwnedAgent.
      if (request.agentId !== agent.id) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      const outcome = await decideToolRequest(toolServiceDeps, agent, request, parsedTool.data.decision, {
        channel: 'app',
      });
      if (!outcome.ok) {
        res.status(outcome.reason === 'already_decided' ? 409 : 400).json({ error: { message: outcome.reason } });
        return;
      }
      res.json({ ok: true, request: { id: request.id, status: outcome.status } });
      return;
    }

    // F′ FP-2: a signing JIT decision (off-chain consent) — approve-once / always-allow / deny.
    if (refType === 'signing') {
      const parsedSig = signingDecisionSchema.safeParse(req.body);
      if (!parsedSig.success) {
        res.status(400).json({ error: { message: 'invalid request body' } });
        return;
      }
      const requestId = (ref as Record<string, unknown>)['requestId'];
      const request = typeof requestId === 'string' ? await getSigningRequest(deps.pool, requestId) : null;
      if (!request) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      // Mirror C-SF3-2: assert the request belongs to THIS agent (same enumeration-
      // oracle discipline as requireOwnedAgent) before any state write.
      if (request.agentId !== agent.id) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      // On `always_allow` we record the standing grant from the REVIEWED descriptor +
      // the request's decoded spender/amount/token/window — a SENSITIVE descriptor
      // nonetheless stays always-ask (00 §6c; the engine re-classifies L2 next time,
      // because `sensitive → L2` is now the classify floor evaluated before any widen
      // check). An un-described request is REFUSED (422), never recorded under a
      // `descriptor:N` fallback key.
      const descriptor = defaultSigningRegistry.get(request.descriptorId);
      if (!descriptor) {
        res.status(422).json({ error: { message: 'unknown descriptor' } });
        return;
      }
      const decoded = request.decoded as Record<string, unknown>;
      // The REAL per-token budget + deadline window are carried on the request at
      // raise time (`signing-service.raiseSigningRequest`), sourced from the grant/
      // build — never the zero placeholder the hollow grant used. If `always_allow`
      // arrives without them, there is no legible grant to record → refuse (422).
      const token = decoded['token'];
      const maxDeadlineWindow = decoded['maxDeadlineWindow'];
      if (
        parsedSig.data.decision === 'always_allow' &&
        !(typeof token === 'string' && typeof maxDeadlineWindow === 'number')
      ) {
        res.status(422).json({ error: { message: 'signing request missing token/deadline binding' } });
        return;
      }
      const grantOnAlways = {
        descriptorId: request.descriptorId,
        descriptorKey: descriptor.key,
        spenderSet: typeof decoded['spender'] === 'string' ? [decoded['spender']] : [],
        perIntentCap: typeof decoded['amountWei'] === 'string' ? decoded['amountWei'] : '0',
        maxDeadlineWindow: typeof maxDeadlineWindow === 'number' ? maxDeadlineWindow : 0,
        token: typeof token === 'string' ? token : '0x0000000000000000000000000000000000000000',
      };
      const outcome = await decideSigningRequest(signingServiceDeps, agent, request, parsedSig.data.decision, grantOnAlways, {
        channel: 'app',
      });
      if (!outcome.ok) {
        res.status(outcome.reason === 'already_decided' ? 409 : 400).json({ error: { message: outcome.reason } });
        return;
      }
      // FP-3 (L2 consent → arm): on an approving decision, fire-and-forget the on-chain arm via the
      // agent's session key (never blocks the HTTP response; the runtime re-validates + records).
      if (parsedSig.data.decision !== 'deny') {
        void deps.runtime?.armApprovedSigning?.(agent.id, request.id);
      }
      res.json({ ok: true, request: { id: request.id, status: outcome.status } });
      return;
    }

    const isCapability = refType === 'capability';
    if (isCapability) {
      const parsedCap = capabilityDecisionSchema.safeParse(req.body);
      if (!parsedCap.success) {
        res.status(400).json({ error: { message: 'invalid request body' } });
        return;
      }
      const requestId = (ref as Record<string, unknown>)['requestId'];
      const request = typeof requestId === 'string' ? await getCapabilityRequest(deps.pool, requestId) : null;
      if (!request) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
      const outcome = await decideCapabilityRequest(capabilityDeps, agent, request, parsedCap.data.decision, {
        txHash: parsedCap.data.txHash,
        rule: parsedCap.data.rule ? toCallRule(parsedCap.data.rule) : undefined,
        channel: 'app',
      });
      if (!outcome.ok) {
        res.status(outcome.reason === 'already_decided' ? 409 : 400).json({ error: { message: outcome.reason } });
        return;
      }
      // SE-2 (SD-E2): approve_once → the runtime auto-retries + consumes the
      // on-chain one-shot exactly once. Fire-and-forget (never blocks the HTTP
      // response; freshness re-check + fail-safe live in the runtime path).
      if (parsedCap.data.decision === 'approve_once') {
        void deps.runtime.consumeApprovedOneShot(agent.id, request.id);
      }
      res.json({ ok: true, request: { id: request.id, status: outcome.status } });
      return;
    }

    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    // THE shared decision path (approvals/decide.ts) — the exact rails the
    // Telegram inline callback rides too (spec §3b): consent durable before
    // forward, supervised activation after consent (P3C-2 bound), alert
    // auto-resolve on any channel.
    const outcome = await decideApprovalWithConsent(
      { pool: deps.pool, hub: deps.hub, broker: deps.broker, coordinator: deps.coordinator, alerts: deps.alerts },
      agent,
      approval,
      parsed.data.decision,
      { channel: 'app', reason: parsed.data.reason },
    );
    if (!outcome.ok) {
      res.status(409).json({ error: { message: 'already decided' } });
      return;
    }
    res.json({ ok: true, approval: { id: approval.id, state: outcome.state } });
  }));

  /**
   * M-03: read the live on-chain guardian and, when it differs from the stored
   * lane key, persist it. Returns the new value when a resync happened.
   * Best-effort — a read failure must not mask the original revoke error.
   */
  async function resyncGuardian(agent: AgentRow): Promise<string | null> {
    try {
      assertNativeAgent(agent); // only reached on a native on-chain revoke failure
      const onchain = await chainForAgent(agent).getGuardian(agent.accountAddr);
      if (onchain !== (agent.guardianAddr ?? '')) {
        await updateAgentGuardian(deps.pool, agent.id, onchain);
        return onchain;
      }
    } catch (readErr) {
      console.error(`guardian resync failed for agent ${agent.id}`, readErr);
    }
    return null;
  }

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
    // 404 for foreign-owned, same enumeration-oracle rule as requireOwnedAgent.
    if (agentId !== undefined) {
      const agent = await getAgentById(deps.pool, agentId);
      if (!agent || agent.ownerAddr !== req.ownerAddr) {
        res.status(404).json({ error: { message: 'not found' } });
        return;
      }
    }
    if (linkId !== undefined) {
      const link = await getLink(deps.pool, linkId);
      if (!link || link.ownerAddr !== req.ownerAddr) {
        res.status(404).json({ error: { message: 'not found' } });
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
      // SF-2: a bound agent revokes with no on-chain tx (no session authority).
      if (fresh.bindMode === 'external') {
        await applyRevokeFanout(
          { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator, alerts: deps.alerts },
          fresh.id,
          'guardian-api',
        );
        results.push({ agentId: fresh.id, ok: true, status: 'revoked', bindMode: 'external' });
        continue;
      }
      assertNativeAgent(fresh);
      try {
        const { txHash } = await chainForAgent(fresh).revoke(fresh.accountAddr, fresh.guardianAddr);
        await applyRevokeFanout(
          { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator, alerts: deps.alerts },
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
        const resynced = await resyncGuardian(fresh); // M-03 self-heal (see single route)
        const rec = await appendTrace(deps.pool, {
          agentId: fresh.id,
          kind: 'error',
          detail: {
            summary: 'guardian revoke failed — agent NOT revoked on-chain',
            message,
            ...(resynced ? { guardianResynced: resynced } : {}),
          },
        });
        deps.hub.emit(fresh.id, 'trace', traceEvent(rec));
        await deps.alerts.emit(fresh.ownerAddr, {
          agentId: fresh.id,
          class: 'info',
          kind: 'revoke_failed',
          summary: `One-click revoke failed for ${fresh.name} — revoke from your owner wallet instead (always works)`,
          refs: { traceSeq: rec.seq },
          dedupKey: `revoke_failed:${fresh.id}`,
        });
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

  // SF-2 (F-2a): bind an agent that already runs elsewhere onto the governed
  // gateway. Creates a bound `agents` row + bound_agents side-table row; returns
  // the gateway/MCP endpoints + the (once-shown) gateway token + base_url swap.
  // No session key is ever minted (F-2b zero-authority).
  router.post('/api/agents/bind-external', asyncRoute(async (req: OwnerRequest, res) => {
    const ownerAddr = req.ownerAddr as string;
    // M-01: per-owner rate ceiling (argon2id cost) + quota (bound agents are
    // agents rows → they count toward the owner's create quota, same as native).
    if (!bindRateOk(ownerAddr)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if ((await countAgentsByOwner(deps.pool, ownerAddr)) >= deps.settings.createQuotaPerOwner) {
      res.status(403).json({ error: 'quota_exceeded', limit: deps.settings.createQuotaPerOwner });
      return;
    }
    const parsed = bindExternalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const d = parsed.data;
    try {
      const result = await bindExternalAgent(
        { pool: deps.pool, publicBaseUrl: deps.settings.publicBaseUrl, keyEncryptionSecret: deps.settings.keyEncryptionSecret },
        {
          ownerAddr: req.ownerAddr as string,
          name: d.name,
          ...(d.interactionMode ? { interactionMode: d.interactionMode } : {}),
          ...(d.toolAllowlist ? { toolAllowlist: d.toolAllowlist } : {}),
          ...(d.leashedAccountAddr ? { leashedAccountAddr: d.leashedAccountAddr } : {}),
          ...(d.chainId !== undefined ? { chainId: d.chainId } : {}),
          ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
        },
      );
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof BindRefusedError) {
        res.status(409).json({ error: { message: err.message, reason: err.code } });
        return;
      }
      throw err;
    }
  }));

  // SF-2: unbind — one-move revoke for a bound agent (no on-chain tx). The
  // gateway auth 403 then closes BOTH inference and tools (fails-closed).
  router.post('/api/agents/:id/unbind', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (agent.bindMode !== 'external') {
      res.status(409).json({ error: { message: 'not a bound agent', reason: 'not_external' } });
      return;
    }
    await applyRevokeFanout(
      { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator, alerts: deps.alerts },
      agent.id,
      'guardian-api',
    );
    res.json({ ok: true, status: 'revoked', bindMode: 'external' });
  }));

  // SF-2: rotate a bound agent's gateway token. Mints a new token (old one
  // invalid immediately) and keeps the bound_agents side-table hash in sync.
  router.post('/api/agents/:id/rotate-gateway-token', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (agent.bindMode !== 'external') {
      res.status(409).json({ error: { message: 'not a bound agent; use POST /api/agents/:id/rotate', reason: 'not_external' } });
      return;
    }
    const token = generateGatewayToken();
    const tHash = await hashTokenSecret(token.secret);
    await rotateAgentToken(deps.pool, agent.id, token.tokenId, tHash, encryptSecret(token.token, deps.settings.keyEncryptionSecret));
    await updateBoundTokenHash(deps.pool, agent.id, tHash);
    res.json({ gatewayToken: token.token }); // returned once
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
    // SF-2 (F-2b): a bound agent has no session key → no runnable loop. It is
    // governed at the gateway (its own base_url drives it), never started by the
    // LEASH runtime. Refuse loudly so this invariant is explicit, not implicit.
    if (agent.bindMode === 'external') {
      res.status(409).json({ error: { message: 'external bound agents run on their own host; they are not started by LEASH', reason: 'external_bind' } });
      return;
    }
    try {
      await deps.runtime.start(agent.id);
    } catch (err) {
      // F-6: a non-holder instance must refuse loudly, not 500 opaquely.
      if (err instanceof Error && err.name === 'RuntimeLeaseNotHeldError') {
        res.status(503).json({ error: { message: err.message, reason: 'runtime_lease_not_held' } });
        return;
      }
      throw err;
    }
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
    // SF-2 (F-2d): one-move revoke for a bound agent needs NO on-chain tx — it
    // holds no session authority. Flip status + fan out; the gateway auth 403
    // then closes BOTH inference and tools in one move (fails-closed). The
    // on-chain revoke path below is untouched for native agents.
    if (agent.bindMode === 'external') {
      await applyRevokeFanout(
        { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator, alerts: deps.alerts },
        agent.id,
        'guardian-api',
      );
      res.json({ ok: true, status: 'revoked', bindMode: 'external' });
      return;
    }
    assertNativeAgent(agent);
    try {
      const { txHash } = await chainForAgent(agent).revoke(agent.accountAddr, agent.guardianAddr);
      await applyRevokeFanout(
        { pool: deps.pool, hub: deps.hub, runtime: deps.runtime, coordinator: deps.coordinator, alerts: deps.alerts },
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
      // M-03 self-heal: an owner setGuardian (or key rotation) leaves the
      // stored guardian stale — the revoke then reverts NotGuardianOrOwner.
      // Resync from chain so the NEXT attempt picks the right lane (or knows
      // LEASH holds no guardian at all).
      const resynced = await resyncGuardian(agent);
      const rec = await appendTrace(deps.pool, {
        agentId: agent.id,
        kind: 'error',
        detail: {
          summary: 'guardian revoke failed — agent NOT revoked on-chain',
          message,
          ...(resynced ? { guardianResynced: resynced } : {}),
        },
      });
      deps.hub.emit(agent.id, 'trace', traceEvent(rec));
      // Daily loop: actionable steer — the owner-wallet fallback works even
      // when LEASH is down (C-2 + spec §3b revoke_failed).
      await deps.alerts.emit(agent.ownerAddr, {
        agentId: agent.id,
        class: 'info',
        kind: 'revoke_failed',
        summary: `One-click revoke failed for ${agent.name} — revoke from your owner wallet instead (always works)`,
        refs: { traceSeq: rec.seq },
        dedupKey: `revoke_failed:${agent.id}`,
      });
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

  // ------------------------------------------------------------------
  // Phase 3 — daily loop routes (spec §4)
  // ------------------------------------------------------------------

  // Owner aggregate SSE (S8): ALL the owner's agents' events tagged agentId,
  // plus owner-level alert / digest_ready frames.
  router.get('/api/owner/stream', asyncRoute(async (req: OwnerRequest, res) => {
    deps.hub.attachOwner(req.ownerAddr as string, res);
  }));

  const alertListQuery = z.object({
    class: z.enum(['decision', 'info']).optional(),
    kind: z.enum(['approval_required', 'limit_hit', 'revoked', 'revoke_failed', 'delegation_terminal', 'runtime_error', 'throttle', 'alert_storm']).optional(),
    agentId: z.string().uuid().optional(),
    status: z.enum(['unread', 'read', 'resolved', 'dismissed']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  router.get('/api/alerts', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = alertListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid query' } });
      return;
    }
    const q = parsed.data;
    const { alerts, nextCursor } = await listAlerts(deps.pool, req.ownerAddr as string, {
      ...(q.class !== undefined ? { class: q.class } : {}),
      ...(q.kind !== undefined ? { kind: q.kind } : {}),
      ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    const unread = await countUnread(deps.pool, req.ownerAddr as string);
    res.json({ alerts, unread, ...(nextCursor !== undefined ? { nextCursor } : {}) });
  }));

  // Registered BEFORE /api/alerts/:id — express matches in order and
  // 'read-all' would otherwise be swallowed as an :id.
  router.post('/api/alerts/read-all', asyncRoute(async (req: OwnerRequest, res) => {
    const n = await markAllInfoRead(deps.pool, req.ownerAddr as string);
    res.json({ ok: true, marked: n });
  }));

  const alertActionSchema = z.object({ action: z.enum(['read', 'dismiss']) });

  router.post('/api/alerts/:id', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = alertActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const alert = await getAlertRow(deps.pool, req.params['id'] ?? '');
    if (!alert || alert.ownerAddr !== req.ownerAddr) {
      // Same shape for missing and foreign (no existence oracle).
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    if (parsed.data.action === 'read') {
      const updated = await markAlertRead(deps.pool, alert.id);
      res.json({ ok: true, alert: updated ?? alert });
      return;
    }
    // Dismiss: approval_required resolves ONLY via its approval (spec §4).
    const dismissed = await deps.alerts.dismiss(alert.id);
    if (dismissed === 'not_dismissible') {
      res.status(409).json({ error: { message: 'decision alerts resolve via their approval' } });
      return;
    }
    res.json({ ok: true, alert: dismissed ?? alert });
  }));

  // Owner-stream records + audit (mirror /traces and /audit).
  router.get('/api/owner/records', asyncRoute(async (req: OwnerRequest, res) => {
    const cursorRaw = req.query['cursor'];
    const limitRaw = req.query['limit'];
    const cursor = Number.parseInt(typeof cursorRaw === 'string' ? cursorRaw : '-1', 10);
    const limit = Math.min(Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10) || 50, 200);
    const records = await listOwnerRecords(deps.pool, req.ownerAddr as string, {
      afterSeq: Number.isNaN(cursor) ? -1 : cursor,
      limit,
    });
    const verdict = await verifyOwnerChainIncremental(deps.pool, req.ownerAddr as string);
    const last = records[records.length - 1];
    res.json({ records, nextCursor: last ? last.seq : null, chainVerified: verdict.ok });
  }));

  router.get('/api/owner/audit', asyncRoute(async (req: OwnerRequest, res) => {
    const rows = await deps.pool.query<{
      batch_id: string;
      seq_from: string;
      seq_to: string;
      merkle_root: string;
      storage_tx: string;
      created_at: Date;
    }>(`SELECT * FROM owner_audit_batches WHERE owner_addr = $1 ORDER BY seq_from ASC`, [req.ownerAddr]);
    const indexer = deps.settings.storageIndexerUrl.replace(/\/$/, '');
    res.json(
      rows.rows.map((r) => ({
        batchId: r.batch_id,
        ownerAddr: req.ownerAddr,
        seqFrom: Number(r.seq_from),
        seqTo: Number(r.seq_to),
        merkleRoot: r.merkle_root,
        storageTx: r.storage_tx,
        createdAt: r.created_at.toISOString(),
        ciphertextUrl: `${indexer}/file?root=${r.merkle_root}`,
      })),
    );
  }));

  // Digest (spec §4): GET = preview (cursor untouched); POST /mark = generate
  // + advance cursor + append the owner-stream digest record (one tx,
  // owner-serialized — a mark racing the scheduled push cannot double-count).
  router.get('/api/digest', asyncRoute(async (req: OwnerRequest, res) => {
    const { digest } = await deps.digest.compute(req.ownerAddr as string);
    res.json({ digest });
  }));

  router.post('/api/digest/mark', asyncRoute(async (req: OwnerRequest, res) => {
    const digest = await deps.digest.mark(req.ownerAddr as string);
    res.json({ ok: true, digest });
  }));

  // Telegram link flow (spec §4; Privy-authed — the DEEP LINK is the only
  // thing that leaves this surface). 503 when the bot is not configured.
  router.post('/api/owner/telegram/link', asyncRoute(async (req: OwnerRequest, res) => {
    if (!deps.telegram) {
      res.status(503).json({ error: { message: 'telegram is not configured on this deployment' } });
      return;
    }
    const { url, expiresAt } = await deps.telegram.issueLinkToken(req.ownerAddr as string);
    res.json({ url, expiresAt });
  }));

  router.delete('/api/owner/telegram', asyncRoute(async (req: OwnerRequest, res) => {
    if (!deps.telegram) {
      res.status(503).json({ error: { message: 'telegram is not configured on this deployment' } });
      return;
    }
    await deps.telegram.unlink(req.ownerAddr as string);
    res.json({ ok: true });
  }));

  router.post('/api/owner/telegram/ping', asyncRoute(async (req: OwnerRequest, res) => {
    if (!deps.telegram) {
      res.status(503).json({ error: { message: 'telegram is not configured on this deployment' } });
      return;
    }
    const sent = await deps.telegram.ping(req.ownerAddr as string);
    if (!sent) {
      res.status(409).json({ error: { message: 'telegram is not linked' } });
      return;
    }
    res.json({ ok: true });
  }));

  const settingsPatchSchema = z.object({
    alertPrefs: z.record(z.string(), z.object({ telegram: z.boolean().optional() })).optional(),
    digestHourUtc: z.number().int().min(0).max(23).nullable().optional(),
    digestOptout: z.boolean().optional(),
    // Same accepted pubkey shapes as the agent audit key.
    streamPubkey: z.string().regex(/^(0x)?0[23][0-9a-fA-F]{64}$|^(0x)?04[0-9a-fA-F]{128}$/).optional(),
  });

  router.get('/api/owner/settings', asyncRoute(async (req: OwnerRequest, res) => {
    const s = await getOwnerSettings(deps.pool, req.ownerAddr as string);
    // telegram_chat_id itself is never exposed — linked-or-not is enough.
    res.json({
      alertPrefs: s.alertPrefs,
      digestHourUtc: s.digestHourUtc,
      digestOptout: s.digestOptout,
      telegramLinked: s.telegramChatId !== null,
      telegramLinkedAt: s.telegramLinkedAt,
      streamPubkeySet: s.streamPubkey !== null,
    });
  }));

  router.patch('/api/owner/settings', asyncRoute(async (req: OwnerRequest, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    try {
      const s = await patchOwnerSettings(deps.pool, req.ownerAddr as string, {
        ...(parsed.data.alertPrefs !== undefined ? { alertPrefs: parsed.data.alertPrefs } : {}),
        ...(parsed.data.digestHourUtc !== undefined ? { digestHourUtc: parsed.data.digestHourUtc } : {}),
        ...(parsed.data.digestOptout !== undefined ? { digestOptout: parsed.data.digestOptout } : {}),
        ...(parsed.data.streamPubkey !== undefined
          ? { streamPubkey: parsed.data.streamPubkey.replace(/^0x/, '') }
          : {}),
      });
      res.json({
        ok: true,
        alertPrefs: s.alertPrefs,
        digestHourUtc: s.digestHourUtc,
        digestOptout: s.digestOptout,
        telegramLinked: s.telegramChatId !== null,
        streamPubkeySet: s.streamPubkey !== null,
      });
    } catch (err) {
      if (err instanceof StreamKeyAlreadySetError) {
        res.status(409).json({ error: { message: 'owner-stream key is already set (rotation is a later slice)' } });
        return;
      }
      throw err;
    }
  }));

  // ---- Phase-4 ACP jobs (spec §5/§7): owner-seeded job spec registry +
  // the job projection read model. Authority stays server-side (F4/F5): the
  // fee amount comes from the seeded spec, never from model/envelope text. ----

  const jobSpecBodySchema = z
    .object({
      sourceRef: z.string().min(1).max(200),
      spec: jobSpecSchema,
      acceptance: acceptanceRuleSetSchema,
      feeAmountWei: weiSchema,
    })
    .strict();

  // Seed / update the owner-defined job a requester will run (F5). The
  // requester's goal.jobSpecSource points at `sourceRef`.
  router.put('/api/job-specs/:ref', asyncRoute(async (req: OwnerRequest, res) => {
    const ownerAddr = req.ownerAddr as string;
    const ref = req.params['ref'] ?? '';
    const parsed = jobSpecBodySchema.safeParse({ ...req.body, sourceRef: ref });
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid job spec', issues: parsed.error.issues } });
      return;
    }
    // Defence in depth (F4): the acceptanceRef in the spec should name the
    // acceptance set the requester resolves — we store them together so the
    // runtime never has to trust envelope text for either.
    await upsertJobSpec(deps.pool, ownerAddr, ref, {
      spec: parsed.data.spec,
      acceptance: parsed.data.acceptance,
      feeAmountWei: parsed.data.feeAmountWei,
    });
    res.json({ ok: true, sourceRef: ref });
  }));

  // D-A2: list the owner's saved job specs for the requester job-handle picker
  // (closes the free-text `js-ref` ↔ `getJobSpec` dead-end). Read-only,
  // owner-scoped — a cross-owner caller only ever sees their own handles.
  router.get('/api/job-specs', asyncRoute(async (req: OwnerRequest, res) => {
    const specs = await listJobSpecs(deps.pool, req.ownerAddr as string);
    res.json({ specs });
  }));

  // D-B1/B2: spec-elevation — turn rough intent into a QUARANTINED draft. This
  // route WRITES NOTHING (the quarantine invariant, spec §8): authority is
  // persisted only by the owner's confirm on the existing create path. Owner-
  // authed (inherited) + a lightweight per-owner rate limit (LLM-spam vector).
  router.post('/api/create/elevate', asyncRoute(async (req: OwnerRequest, res) => {
    const ownerAddr = req.ownerAddr as string;
    if (!elevateRateOk(ownerAddr) || !(await globalLlmOk())) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const parsed = elevateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const { intent, answers, role } = parsed.data;
    const draft = await elevateIntent(
      { queue: deps.queue, model: deps.settings.elevationModel },
      {
        intent,
        ...(answers !== undefined ? { answers } : {}),
        ...(role !== undefined ? { role } : {}),
      },
    );
    res.json({ draft });
  }));

  // ---- Phase-5.5: Conversational Direction (spine) --------------------------
  // POST /api/agents/:id/direct — direction-time elevation. QUARANTINE (D-2):
  // WRITES NO AUTHORITY (persists only a `draft` directions row; no goal/policy/
  // job-spec write). Returns the agent's own read-back for the owner to confirm.
  router.post('/api/agents/:id/direct', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (!directRateOk(req.ownerAddr as string) || !(await globalLlmOk())) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const parsed = directSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const { intent, answers } = parsed.data;
    const draft = await elevateDirection(
      { queue: deps.queue, model: deps.settings.elevationModel },
      {
        agentId: agent.id,
        currentGoal: agent.goal,
        capabilityLabel: agent.capabilityLabel,
        intent,
        ...(answers !== undefined ? { answers } : {}),
      },
    );
    const row = await insertDirectionDraft(deps.pool, {
      agentId: agent.id,
      ownerAddr: req.ownerAddr as string,
      intent,
      ...(answers !== undefined ? { answers } : {}),
      draft,
    });
    // C2 (Phase 5.6): abandoned-draft pruning moved OFF this hot path to a
    // periodic sweep (index.ts, mirroring the Phase-2 delegation sweeper) — the
    // 5.5 review flagged prune-on-every-call as a NIT.
    res.json({ direction: { id: row.id, draft } });
  }));

  // POST /api/agents/:id/direct/:directionId/confirm — the SOLE authority write
  // for a directive (D-3). Server re-validates the owner-confirmed patch at this
  // boundary (R-1), computes the EFFECTIVE goal (recipient owner-typed out-of-band),
  // appends an ordered hash-chained `direction` consent record, and marks the
  // directive confirmed. The runtime sense_direction step applies it next cycle.
  router.post('/api/agents/:id/direct/:directionId/confirm', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const directionId = req.params['directionId'] ?? '';
    const dir = await getDirection(deps.pool, directionId);
    if (!dir || dir.agentId !== agent.id) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    if (dir.status !== 'draft') {
      res.status(409).json({ error: 'already_decided' });
      return;
    }
    const parsed = directConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const { edited, recipient } = parsed.data;
    // R-1 at confirm: only-descriptive, in-union, role-locked.
    const g1 = applyGoalPatch(agent.goal, edited.goalPatch as GoalPatch | undefined);
    if (!g1.ok) {
      res.status(400).json({ error: 'invalid_directive', reason: g1.reason });
      return;
    }
    // Never-guess-money: an address is owner-typed + out-of-band, never in the patch.
    const g2 = applyRecipient(g1.goal, recipient);
    if (!g2.ok) {
      res.status(400).json({ error: 'invalid_recipient', reason: g2.reason });
      return;
    }
    // Optional acceptance tuning (R-1): validate against the AcceptanceRule union
    // and resolve the target job spec FIRST (pure/read-only), but DEFER the
    // authority write until AFTER the confirm CAS wins — so a double/racing
    // confirm that loses the CAS (409) never mutates the job spec (atomicity).
    let acceptanceWrite:
      | { ref: string; spec: import('../store/job-specs.js').OwnerJobSpec; rules: import('../jobs/acceptance.js').AcceptanceRule[] }
      | null = null;
    if (edited.acceptancePatch !== undefined) {
      const va = validateAcceptancePatch(edited.acceptancePatch);
      if (!va.ok) {
        res.status(400).json({ error: 'invalid_acceptance', reason: va.reason });
        return;
      }
      if (goalRole(agent.goal) !== 'requester') {
        res.status(400).json({ error: 'acceptance_requires_job_agent' });
        return;
      }
      const ref = (agent.goal as { jobSpecSource?: string }).jobSpecSource ?? '';
      const spec = await getJobSpec(deps.pool, req.ownerAddr as string, ref);
      if (!spec) {
        res.status(400).json({ error: 'job_spec_not_found' });
        return;
      }
      acceptanceWrite = { ref, spec, rules: va.rules };
    }
    // Phase 5.6 (D-1): validate the optional owner-authored chain plan BEFORE
    // the authority write — an invalid/cross-owner/unlinked/cyclic plan is a
    // visible 400, never silently dropped, and no chain is armed. Pure/read-only.
    const chainPlan = parsed.data.chainPlan;
    if (chainPlan !== undefined) {
      const v = await validateChainPlan(deps.pool, req.ownerAddr as string, agent.id, chainPlan, {
        maxDepth: deps.settings.chainMaxDepth,
        maxEligiblePerHop: deps.settings.chainMaxEligiblePerHop,
      });
      if (!v.ok) {
        res.status(400).json({ error: v.error, reason: v.reason });
        return;
      }
    }
    const confirmed = await confirmDirection(deps.pool, directionId, g2.goal);
    if (!confirmed) {
      res.status(409).json({ error: 'already_decided' });
      return;
    }
    // CAS won ⇒ the directive is durably confirmed; only now apply the acceptance
    // tuning (owner-authored authority), so it is atomic-with-confirm in effect.
    if (acceptanceWrite) {
      await upsertJobSpec(deps.pool, req.ownerAddr as string, acceptanceWrite.ref, {
        ...acceptanceWrite.spec,
        acceptance: { ...acceptanceWrite.spec.acceptance, rules: acceptanceWrite.rules },
      });
    }
    // The ordered, hash-chained `direction` consent record (00 §7, D-3): original
    // intent + effective directive, decidedBy owner. Same two-tier proof as spend.
    const rec = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'direction',
      decision: 'approve',
      decidedBy: 'owner',
      originalRequest: { intent: dir.intent },
      effectiveRequest: { effectiveGoal: g2.goal as unknown as Json, recipientSet: recipient ? true : false },
      detail: { directionId, summary: 'owner confirmed a conversational direction' },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(rec));
    // Phase 5.6 (D-1/D-2): the CAS won ⇒ record the owner-authored plan as a
    // `planned` chain projection — QUARANTINED, holds NO armed authority (no
    // delegation, no policy tx). The runtime proposes hop 0 after this directed
    // agent's next cycle; each spender hop still needs the owner's approval.
    if (chainPlan !== undefined && chainPlan.length > 0) {
      await insertPlannedChain(deps.pool, {
        ownerAddr: req.ownerAddr as string,
        originAgentId: agent.id,
        directionId,
        plan: chainPlan as unknown as ChainStep[],
      });
    }
    res.json({ ok: true });
  }));

  // GET /api/chains — owner-scoped chain read-model (D-6). Read-only, writes
  // NOTHING, its OWN rate ceiling (N-1). Confers no authority.
  router.get('/api/chains', asyncRoute(async (req: OwnerRequest, res) => {
    if (!chainsRateOk(req.ownerAddr as string)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const { chains, nextCursor } = await listChainsByOwner(deps.pool, req.ownerAddr as string, {
      ...(cursor ? { cursor } : {}),
    });
    res.json({ chains, ...(nextCursor ? { nextCursor } : {}) });
  }));

  // GET /api/chains/:id — one chain + its ordered hops (D-6). Owner-scoped
  // (cross-owner → 404, D-8); read-only.
  router.get('/api/chains/:id', asyncRoute(async (req: OwnerRequest, res) => {
    if (!chainsRateOk(req.ownerAddr as string)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const chain = await getChain(deps.pool, req.params['id'] ?? '');
    if (!chain || chain.ownerAddr !== req.ownerAddr) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    // Ordered hops: the chain's hop delegations (by chainId in payload), oldest-first.
    const hops = await listChainHopDelegations(deps.pool, chain.id);
    res.json({ chain, hops });
  }));

  // GET /api/agents/:id/status?q=… — read-only conversational status (D-7). WRITES
  // NOTHING. The answer is quarantined-untrusted plain text (never authority).
  router.get('/api/agents/:id/status', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (!statusRateOk(req.ownerAddr as string) || !(await globalLlmOk())) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const qRaw = req.query['q'];
    const q = (typeof qRaw === 'string' ? qRaw : '').trim();
    if (!q) {
      res.status(400).json({ error: { message: 'q is required' } });
      return;
    }
    // C14: the 500-char cap is a WALL, not a silent truncation — a trimmed-
    // behind-your-back question would get an answer to a different question.
    if (q.length > 500) {
      res.status(400).json({ error: { message: 'q is too long (max 500 characters)' } });
      return;
    }
    const answer = await answerStatus(
      { pool: deps.pool, queue: deps.queue, model: deps.settings.elevationModel },
      { agentId: agent.id, agentName: agent.name, q },
    );
    res.json(answer);
  }));

  // ---- Stage D: governed-calldata grant surfaces (spec §3b/§4) ----------------
  // The owner signs every on-chain grant tx CLIENT-SIDE (Privy owner wallet, the
  // proposePolicy/proposeAllowlist path since Phase 1). These routes RESOLVE the
  // exact rule params (from server-side catalog state, never model text) + RECORD
  // the read-model after the owner reports the tx hash — the backend never holds
  // owner authority and never submits a grant tx.

  // Apply a capability preset (D-9): resolve → the batch of proposeCallRule params
  // the FE signs; when a txHash is supplied (owner already signed the batch),
  // record the applied preset + its grants (proposed, loosen-timelock in flight).
  router.post('/api/agents/:id/capabilities/preset', asyncRoute(async (req: OwnerRequest, res) => {
    if (!capabilitiesRateOk(req.ownerAddr ?? '')) {
      res.status(429).json({ error: { message: 'rate limited' } });
      return;
    }
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = presetApplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    if (!presetKeys().includes(parsed.data.presetKey as PresetKey)) {
      res.status(400).json({ error: { message: 'unknown preset' } });
      return;
    }
    const resolved = resolvePreset(parsed.data.presetKey as PresetKey, catalogForAgent(agent));
    if (!resolved.ok) {
      res.status(422).json({ error: { message: resolved.reason } });
      return;
    }
    const offList = resolved.preset.rules.find((r) => !targetGrantable(agent, r.target));
    if (offList) {
      res.status(422).json({
        error: { message: `preset target ${offList.target} is outside this chain's protocol allowlist` },
      });
      return;
    }
    if (parsed.data.txHash) await recordPresetGrants(deps.pool, agent, resolved.preset, parsed.data.txHash);
    res.json({ ok: true, preset: resolved.preset, recorded: Boolean(parsed.data.txHash) });
  }));

  // Propose / tighten / remove a custom governed-call rule. propose = loosen
  // (timelocked on-chain); tighten = instant; remove = instant. The read-model is
  // recorded after the owner reports the signed tx (remove is recorded eagerly —
  // a tighten/remove is instant and fail-safe).
  router.post('/api/agents/:id/capabilities/rule', asyncRoute(async (req: OwnerRequest, res) => {
    if (!capabilitiesRateOk(req.ownerAddr ?? '')) {
      res.status(429).json({ error: { message: 'rate limited' } });
      return;
    }
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = capabilityRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const rule = toCallRule(parsed.data.rule);
    if (parsed.data.action !== 'remove' && parsed.data.action !== 'apply' && !targetGrantable(agent, rule.target)) {
      res.status(422).json({
        error: { message: `rule target ${rule.target} is outside this chain's protocol allowlist` },
      });
      return;
    }
    if (parsed.data.action === 'remove') {
      await setGrantStatus(deps.pool, agent.id, rule.target, rule.selector, 'removed');
      res.json({ ok: true, action: 'remove' });
      return;
    }
    // FR3 (F-8c): a matured proposed rule the owner applied on-chain — flip the
    // read-model to active. No allowlist re-check: the target was checked at
    // propose, and the on-chain timelock/apply is the enforcement regardless.
    if (parsed.data.action === 'apply') {
      await setGrantStatus(deps.pool, agent.id, rule.target, rule.selector, 'active');
      res.json({ ok: true, action: 'apply' });
      return;
    }
    if (parsed.data.txHash) {
      await upsertGrant(deps.pool, {
        agentId: agent.id,
        ownerAddr: agent.ownerAddr,
        rule,
        source: 'custom',
        status: parsed.data.action === 'tighten' ? 'active' : 'proposed',
        txHash: parsed.data.txHash,
      });
    }
    res.json({ ok: true, action: parsed.data.action, rule, recorded: Boolean(parsed.data.txHash) });
  }));

  // Read-only capability envelope (D-14): granted rules + applied presets +
  // recent JIT decisions. The on-chain account stays authoritative; this is the
  // read-model view for the cockpit.
  router.get('/api/agents/:id/capabilities', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const [grants, presets, recentRequests] = await Promise.all([
      listGrants(deps.pool, agent.id),
      listAppliedPresets(deps.pool, agent.id),
      listRecentRequests(deps.pool, agent.id, 20),
    ]);
    res.json({ grants, presets, recentRequests });
  }));

  // ── SF-3: governed tool-use grant surfaces (STAGE-F §4) ────────────────────
  // Apply a tool preset (default-deny → broad-grant UX). Records the standing
  // tool_rules; a sensitive tool in the preset stays always-ask by construction.
  router.post('/api/agents/:id/tools/preset', asyncRoute(async (req: OwnerRequest, res) => {
    if (!capabilitiesRateOk(req.ownerAddr ?? '')) {
      res.status(429).json({ error: { message: 'rate limited' } });
      return;
    }
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = toolPresetApplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    if (!toolPresetKeys().includes(parsed.data.presetKey as ToolPresetKey)) {
      res.status(400).json({ error: { message: 'unknown preset' } });
      return;
    }
    const resolved = expandToolPreset(parsed.data.presetKey as ToolPresetKey);
    if (!resolved) {
      res.status(422).json({ error: { message: 'unresolvable_preset' } });
      return;
    }
    await recordToolPresetGrants(deps.pool, agent, resolved.key, resolved.rules);
    res.json({ ok: true, preset: resolved });
  }));

  // Set or remove a single tool rule (owner-authored allowlist editor).
  router.post('/api/agents/:id/tools/rule', asyncRoute(async (req: OwnerRequest, res) => {
    if (!capabilitiesRateOk(req.ownerAddr ?? '')) {
      res.status(429).json({ error: { message: 'rate limited' } });
      return;
    }
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = toolRuleApplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const toolId = parsed.data.rule.toolId.toLowerCase();
    // A tool outside the registry is never grantable (default-deny, never guessed).
    const descriptor = defaultToolRegistry.get(toolId);
    if (!descriptor) {
      res.status(422).json({ error: { message: `unknown tool ${toolId}` } });
      return;
    }
    if (parsed.data.action === 'remove') {
      await setToolRuleStatus(deps.pool, agent.id, toolId, 'removed');
      res.json({ ok: true, action: 'remove' });
      return;
    }
    // Normalize the policy, dropping undefined fields (exactOptionalPropertyTypes).
    const p = parsed.data.rule.perCallPolicy;
    const perCallPolicy =
      p && (p.maxArgBytes !== undefined || p.recipientAllowlist !== undefined || p.urlOriginAllowlist !== undefined)
        ? {
            ...(p.maxArgBytes !== undefined ? { maxArgBytes: p.maxArgBytes } : {}),
            ...(p.recipientAllowlist !== undefined ? { recipientAllowlist: p.recipientAllowlist } : {}),
            ...(p.urlOriginAllowlist !== undefined ? { urlOriginAllowlist: p.urlOriginAllowlist } : {}),
          }
        : undefined;
    const rule: ToolRule = {
      toolId,
      allowed: parsed.data.rule.allowed,
      // a globally/registry-sensitive tool can never be granted non-sensitive.
      sensitive: parsed.data.rule.sensitive || descriptor.sensitive,
      ...(perCallPolicy ? { perCallPolicy } : {}),
    };
    await upsertToolRule(deps.pool, { agentId: agent.id, ownerAddr: agent.ownerAddr, rule, source: 'custom', status: 'active' });
    res.json({ ok: true, action: 'set', rule });
  }));

  // Read-only tool envelope: granted rules + applied presets + recent JIT decisions.
  router.get('/api/agents/:id/tools', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const [rules, presets, recentRequests] = await Promise.all([
      listToolRules(deps.pool, agent.id),
      listAppliedToolPresets(deps.pool, agent.id),
      listRecentToolRequests(deps.pool, agent.id, 20),
    ]);
    res.json({ rules, presets, recentRequests, available: defaultToolRegistry.list() });
  }));

  // ── F′ FP-2: governed-signing grant surfaces (STAGE-F-PRIME §4) ────────────
  // Set or remove a single signing rule (owner-authored signing-intent-policy
  // editor). The descriptor MUST be a reviewed registry entry that passes the
  // N-01/N-02 engine assertions (fail-closed, never a silent on-chain
  // never-validates); the response returns the on-chain grant params the owner's
  // client signs (`proposeSigningGrant`) so the engine's domainSeparator/typeHash
  // and the wall's stored values are byte-identical. This route records ONLY the
  // read-model mirror — the on-chain policy row is the authority.
  router.post('/api/agents/:id/signing/rule', asyncRoute(async (req: OwnerRequest, res) => {
    if (!capabilitiesRateOk(req.ownerAddr ?? '')) {
      res.status(429).json({ error: { message: 'rate limited' } });
      return;
    }
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const parsed = signingRuleApplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const descriptorId = parsed.data.rule.descriptorId;
    // A descriptor outside the reviewed registry is never grantable (default-deny,
    // never inferred — 00 §9). This is the off-chain floor the engine enforces.
    const descriptor = defaultSigningRegistry.get(descriptorId);
    if (!descriptor) {
      res.status(422).json({ error: { message: `unknown descriptor ${descriptorId}` } });
      return;
    }
    // N-01/N-02 re-assertion at grant time (loud reviewer error, never silent).
    try {
      assertDescriptor(descriptor);
    } catch (e) {
      if (e instanceof DescriptorError) {
        res.status(422).json({ error: { message: e.message, code: e.code } });
        return;
      }
      throw e;
    }
    if (parsed.data.action === 'remove') {
      await setSigningRuleStatus(deps.pool, agent.id, descriptorId, 'removed');
      // FP-CARRY-4/5: removing a descriptor is a signing-relevant tighten → the
      // on-chain epoch bumps. Reconcile the read-model so dead arms show stale — but
      // SCOPED to the removed descriptor. (The owner's on-chain `removeSigningDescriptor`
      // tx does the actual epoch bump; here we stale only this descriptor's arms, not
      // every descriptor's as the old epoch-sentinel call did.)
      await reconcileSigningArmsByDescriptor(deps.pool, agent.id, descriptorId);
      res.json({ ok: true, action: 'remove' });
      return;
    }
    const rule: SigningRuleType = {
      descriptorId,
      spenderSet: parsed.data.rule.spenderSet.map((s) => s.toLowerCase()),
      perIntentCap: parsed.data.rule.perIntentCap,
      maxDeadlineWindow: parsed.data.rule.maxDeadlineWindow,
      token: parsed.data.rule.token.toLowerCase(),
      active: true,
    };
    await upsertSigningRule(deps.pool, {
      agentId: agent.id,
      ownerAddr: agent.ownerAddr,
      descriptorKey: descriptor.key,
      rule,
      source: 'custom',
      status: 'active',
    });
    res.json({ ok: true, action: 'set', rule, onChainGrant: onChainGrantParams(descriptor) });
  }));

  // Read-only signing envelope: granted rules + reviewed descriptors + recent JIT
  // decisions + the armed-intent read-model (arms flagged `stale` after a tighten).
  router.get('/api/agents/:id/signing', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    const [rules, recentRequests, arms] = await Promise.all([
      listSigningRules(deps.pool, agent.id),
      listRecentSigningRequests(deps.pool, agent.id, 20),
      listSigningArms(deps.pool, agent.id, 50),
    ]);
    res.json({
      rules,
      recentRequests,
      arms,
      available: defaultSigningRegistry.list().map((d) => ({
        descriptorId: d.descriptorId,
        key: d.key,
        label: d.label,
        protocol: d.protocol,
        sensitive: d.sensitive,
        onChainGrant: onChainGrantParams(d),
      })),
    });
  }));

  // ── SE-7: multichain owner surfaces ────────────────────────────────────────
  // Namespaced /api/networks — "/api/chains" is the Phase-5.6 AGENT-CHAIN
  // (delegation graph) surface; blockchain networks are a different concept.
  // GET /api/networks — the registered chain table (FE chain selector). Config-
  // only onboarding: what this returns IS what can be targeted (default-deny beyond).
  router.get('/api/networks', asyncRoute(async (_req: OwnerRequest, res) => {
    if (!deps.chainRegistry) {
      res.status(503).json({ error: { message: 'multichain_unavailable' } });
      return;
    }
    res.json({
      chains: deps.chainRegistry.listChains().map((c) => ({
        chainId: c.chainId,
        name: c.name,
        // RH2 (two-factory): the named wall-capability keys this chain can mint
        // through (e.g. `oracleBand`). The FE surfaces an opt-in only when present;
        // an empty list means the default V4 factory is the only path.
        capabilities: Object.keys(c.capabilityFactories ?? {}),
        // FR4 (F-9): the chain's canonical swap router — the band-arm surface
        // pins the band to THIS target (config truth, never user/model text).
        router: c.canonical?.router ?? null,
      })),
    });
  }));

  // GET /api/agents/:id/networks — the agent's per-chain presence: home chain +
  // every onboarded chain (same CREATE2 address by construction, SD-E9).
  router.get('/api/agents/:id/networks', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    // SF-2 carry (Gate-② WARNING): an EXTERNAL-bound agent has no on-chain account
    // (account_addr null, chain_id=0 sentinel). Return an explicit external
    // presence rather than a null/zero home-chain card the FE would mis-render.
    if (agent.bindMode === 'external') {
      res.json({ accountAddr: null, onboardable: false, homeChainId: null, bindMode: 'external', chains: [] });
      return;
    }
    const deployments = await listChainDeployments(deps.pool, agent.id);
    res.json({
      accountAddr: agent.accountAddr,
      // Whether this agent CAN onboard to another chain (deterministic V4 with
      // the persisted salt+tuple) — the FE surfaces the action only when true.
      onboardable: agent.accountVersion === 4 && !!agent.accountSalt && !!agent.accountCreateTuple,
      homeChainId: agent.chainId,
      chains: [
        { chainId: agent.chainId, accountAddr: agent.accountAddr, role: 'home' as const },
        ...deployments.map((d) => ({
          chainId: d.chainId,
          accountAddr: d.accountAddr,
          role: 'onboarded' as const,
          createTx: d.createTx,
          registerTx: d.registerTx,
          adopted: d.adopted,
          createdAt: d.createdAt,
        })),
      ],
    });
  }));

  // POST /api/agents/:id/networks — SECOND-CHAIN ONBOARDING (E-7): replay the
  // persisted construction tuple byte-exact on the target chain so the account
  // lands at the SAME address; any tuple/salt drift is REFUSED before minting.
  // ownerAddr comes from the AUTHENTICATED SESSION via requireOwnedAgent (L-04).
  router.post('/api/agents/:id/networks', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    if (!deps.chainRegistry) {
      res.status(503).json({ error: { message: 'multichain_unavailable' } });
      return;
    }
    const parsed = z.object({ chainId: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'invalid request body' } });
      return;
    }
    const registry = deps.chainRegistry;
    try {
      const result = await onboardAgentToChain(
        { pool: deps.pool, getChainOps: (chainId) => registry.getChainOps(chainId) },
        agent,
        parsed.data.chainId,
      );
      const rec = await appendTrace(deps.pool, {
        agentId: agent.id,
        kind: 'decision',
        detail: {
          summary: result.alreadyOnboarded
            ? `${agent.name} is already onboarded on chain ${parsed.data.chainId} (idempotent)`
            : `${agent.name} onboarded onto chain ${parsed.data.chainId} at its same-address account ${agent.accountAddr}${result.adopted ? ' (adopted a pre-existing deterministic deploy)' : ''}`,
        },
      });
      deps.hub.emit(agent.id, 'trace', traceEvent(rec));
      res.status(result.alreadyOnboarded ? 200 : 201).json({
        chainId: result.deployment.chainId,
        accountAddr: result.deployment.accountAddr,
        createTx: result.deployment.createTx,
        registerTx: result.deployment.registerTx,
        adopted: result.adopted,
        alreadyOnboarded: result.alreadyOnboarded,
      });
    } catch (err) {
      if (err instanceof OnboardRefusedError) {
        res.status(409).json({ error: { message: err.message, reason: err.reason } });
        return;
      }
      if (err instanceof UnregisteredChainError) {
        res.status(409).json({ error: { message: err.message, reason: 'unregistered_chain' } });
        return;
      }
      throw err;
    }
  }));

  // GET /api/networks/:chainId/accounts/:accountAddr — the owner-scoped per-chain
  // account view (L-04, BINDING from the SE-6 gate): ownerAddr derives from the
  // AUTHENTICATED SESSION (req.ownerAddr), NEVER caller/request text — under
  // CREATE2 two owners can share an address, so session scoping is what keeps
  // one owner from reading another's agent through a colliding address.
  router.get('/api/networks/:chainId/accounts/:accountAddr', asyncRoute(async (req: OwnerRequest, res) => {
    const chainId = Number.parseInt(req.params['chainId'] ?? '', 10);
    const accountAddr = req.params['accountAddr'] ?? '';
    if (!Number.isInteger(chainId) || chainId <= 0 || !addressSchema.safeParse(accountAddr).success) {
      res.status(400).json({ error: { message: 'invalid chainId or accountAddr' } });
      return;
    }
    const ownerAddr = req.ownerAddr as string; // authenticated session (L-04)
    let agent = await getAgentByAccountAndChain(deps.pool, ownerAddr, chainId, accountAddr);
    if (!agent) {
      // Not a home-chain row — an ONBOARDED chain's presence resolves through
      // the deployment table (still owner-scoped via the agents join).
      const agentId = await getOwnedAgentIdByDeployment(deps.pool, ownerAddr, chainId, accountAddr);
      agent = agentId ? await getAgentById(deps.pool, agentId) : null;
    }
    if (!agent) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    const requests = await listRequestsByChainAndAccount(deps.pool, ownerAddr, chainId, accountAddr, 50);
    res.json({
      agent: { id: agent.id, name: agent.name, status: agent.status, accountAddr: agent.accountAddr, chainId: agent.chainId },
      requests,
    });
  }));

  // POST /api/agents/:id/wind-down — lifespan dial (D-10): owner marks the agent
  // done. Stops the loop and emits a completion alert. Revoke stays a separate
  // explicit owner/guardian action; expiry lapses on its own. Never agent-forced
  // (this route is owner-authed — the agent has no path to it).
  router.post('/api/agents/:id/wind-down', asyncRoute(async (req: OwnerRequest, res) => {
    const agent = await requireOwnedAgent(req, res);
    if (!agent) return;
    await deps.runtime.stop(agent.id);
    // Phase 5.6 (D-4, §8 "wind-down fails safe"): stopping the loop is NOT enough
    // — a chain advances via the loop-independent terminal callback. Terminate the
    // agent's advancing chains where it is the origin AND cancel the in-flight /
    // pending hop, so a running chain can't keep advancing and a planned chain
    // can't resume on restart.
    await terminateOriginChainsForWindDown(
      {
        pool: deps.pool,
        hub: deps.hub,
        coordinator: deps.coordinator,
        config: { maxDepth: deps.settings.chainMaxDepth, maxEligiblePerHop: deps.settings.chainMaxEligiblePerHop },
      },
      agent.id,
    );
    const rec = await appendTrace(deps.pool, {
      agentId: agent.id,
      kind: 'decision',
      detail: { summary: `${agent.name} was wound down by the owner (marked done)` },
    });
    deps.hub.emit(agent.id, 'trace', traceEvent(rec));
    await deps.alerts?.emit(agent.ownerAddr, {
      agentId: agent.id,
      class: 'info',
      kind: 'completed',
      summary: `${agent.name} was wound down (marked done). Its loop is stopped and its on-chain access lapses at expiry; re-arm or restart it to resume.`,
      refs: {},
    });
    res.json({ ok: true });
  }));

  router.get('/api/job-specs/:ref', asyncRoute(async (req: OwnerRequest, res) => {
    const seeded = await getJobSpec(deps.pool, req.ownerAddr as string, req.params['ref'] ?? '');
    if (!seeded) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    res.json(seeded);
  }));

  // The job lifecycle list for the cockpit (spec §7): request → deliver →
  // verify → settle, one row per ACP job.
  router.get('/api/jobs', asyncRoute(async (req: OwnerRequest, res) => {
    const limitRaw = req.query['limit'];
    const limit = Math.min(Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10) || 50, 200);
    const jobs = await listJobsForOwner(deps.pool, req.ownerAddr as string, limit);
    res.json({ jobs: jobs.map(jobView) });
  }));

  // One job's full lifecycle. The deliverable + evaluator rationale are
  // UNTRUSTED (F-quar): the FE renders them QUARANTINED. Only hashes/roots/sigs
  // are the verified PoA fields.
  router.get('/api/jobs/:id', asyncRoute(async (req: OwnerRequest, res) => {
    const job = await getJob(deps.pool, req.params['id'] ?? '');
    if (!job || job.ownerAddr !== req.ownerAddr) {
      res.status(404).json({ error: { message: 'not found' } });
      return;
    }
    res.json(jobView(job));
  }));

  return router;
}

/**
 * Shape a job projection row for the cockpit. The deliverable + rationale are
 * carried through UNTRUSTED (F-quar) — the FE quarantines their display; the
 * verified PoA holds only hashes/roots/sigs.
 */
function jobView(job: import('../store/jobs.js').JobRow): Json {
  return {
    jobId: job.jobId,
    status: job.status,
    spec: job.spec as unknown as Json,
    jobSpecHash: job.jobSpecHash,
    requesterAgentId: job.requesterAgentId,
    providerAgentId: job.providerAgentId,
    evaluatorAgentId: job.evaluatorAgentId,
    feeToken: job.feeToken,
    feeAmountWei: job.feeAmountWei,
    feeRecipient: job.feeRecipient,
    feeTokenSymbol: job.feeTokenSymbol,
    feeTokenDecimals: job.feeTokenDecimals,
    deliverable: job.deliverable ?? null, // UNTRUSTED — FE quarantines
    deliverableRoot: job.deliverableRoot,
    deliverableSummary: job.deliverableSummary, // UNTRUSTED — FE quarantines
    acceptance: (job.acceptance as unknown as Json) ?? null,
    verdict: job.verdict,
    rationaleRef: job.rationaleRef,
    approvalId: job.approvalId,
    settlementTx: job.settlementTx,
    poa: (job.poa as unknown as Json) ?? null,
    blockedBy: job.blockedBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
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
    // Phase-5 (D-B9): inert freeform label for cockpit display (no discovery).
    capabilityLabel: agent.capabilityLabel,
    createdAt: agent.createdAt,
  };
}

type Handler = (req: Request, res: Response) => Promise<void>;

function asyncRoute(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
