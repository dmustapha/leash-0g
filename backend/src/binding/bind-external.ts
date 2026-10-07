import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { generateGatewayToken, hashTokenSecret } from '../crypto/token.js';
import { insertBoundAgentRow } from '../store/agents.js';
import { insertBoundAgent, type InteractionMode } from '../store/bound-agents.js';

/**
 * SF-2 — external Tier-2 bind (F-2a/F-2b).
 *
 * Onboard an agent that ALREADY runs elsewhere onto the governed SF-1/SF-3
 * gateway WITHOUT a rewrite: mint a gateway token, generate a tenant key, and
 * insert a bound `agents` row (`bind_mode='external'`) + its `bound_agents`
 * side-table row. The agent keeps its own code/prompt/logic — only its base_url
 * swaps to LEASH, so its inference + tool traffic now route through the leash.
 *
 * Zero-authority is BY CONSTRUCTION (F-2b): no session key is ever stored, so
 * the runtime can't start it and there is no on-chain spend path. The owner's
 * single lever over it is the gateway (observe + govern + approve + revoke).
 *
 * Minimal inputs (SF-2 §1.2): a name, optional interaction mode (default
 * `observe`), optional tool allowlist (default-deny/empty), optional reference
 * to an on-chain account the owner already has. LEASH generates everything else.
 * The agent's base_url is an INPUT ONLY — used to produce the swap instructions
 * in the response, never stored.
 */
export interface BindExternalDeps {
  pool: Pool;
  /** LEASH's own public base URL; '' in dev ⇒ path-only hints. */
  publicBaseUrl: string;
  keyEncryptionSecret: string;
}

export interface BindExternalInput {
  ownerAddr: string;
  name: string;
  /** SF-2 implements 'observe' only; 'passive'/'active' are declared but DEFERRED to SF-2′. */
  interactionMode?: InteractionMode;
  /** Canonical `server.tool` ids granted at bind; default-deny (empty). */
  toolAllowlist?: string[];
  /** OPTIONAL reference to an on-chain LeashAccount the owner already has. */
  leashedAccountAddr?: string | null;
  chainId?: number | null;
  /** The external agent's current base_url — used ONLY to render swap instructions. */
  baseUrl?: string | null;
}

export interface BindExternalResult {
  agentId: string;
  gatewayUrl: string;
  mcpEndpoint: string;
  /** Returned ONCE — only argon2id(secret) is persisted. */
  gatewayToken: string;
  tenantKey: string;
  baseUrlSwap: { from: string | null; openai: string; anthropic: string };
  interactionMode: InteractionMode;
}

export class BindRefusedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BindRefusedError';
  }
}

function tenantKey(): string {
  return `tnt_${randomBytes(16).toString('hex')}`;
}

export async function bindExternalAgent(deps: BindExternalDeps, input: BindExternalInput): Promise<BindExternalResult> {
  const interactionMode: InteractionMode = input.interactionMode ?? 'observe';
  // SF-2 implements observe only; passive/active are declared at the bind screen
  // (enum present day one) but their BEHAVIOR is deferred to SF-2′. Refuse to
  // mint a bind that claims a mode we do not yet enforce — surfacing, not hiding.
  if (interactionMode !== 'observe') {
    throw new BindRefusedError(
      'interaction_mode_deferred',
      `interaction mode '${interactionMode}' is declared but its behavior is deferred to SF-2′; only 'observe' is active in SF-2`,
    );
  }
  const toolAllowlist = [
    ...new Set((input.toolAllowlist ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0)),
  ];

  const token = generateGatewayToken();
  const tHash = await hashTokenSecret(token.secret);
  const tnt = tenantKey();

  // agents.chain_id is NOT NULL: 0 = off-chain bound (no home chain), else the
  // referenced account's chain.
  const chainId = input.chainId ?? 0;
  const agentId = await insertBoundAgentRow(deps.pool, {
    ownerAddr: input.ownerAddr,
    name: input.name,
    tokenId: token.tokenId,
    tokenHash: tHash,
    chainId,
    // 'observe' ⇒ no standing block/modify rules; traffic is observed + governed
    // (sensitive tools still ALWAYS require approval regardless of rules, 00 §6c).
    gatewayRules: [],
  });
  await insertBoundAgent(deps.pool, {
    agentId,
    leashedAccountAddr: input.leashedAccountAddr ?? null,
    chainId: input.chainId ?? null,
    gatewayTokenHash: tHash,
    mcpScope: toolAllowlist,
    tenantKey: tnt,
    interactionMode,
  });

  const base = deps.publicBaseUrl.replace(/\/$/, '');
  return {
    agentId,
    gatewayUrl: `${base}/v1`,
    mcpEndpoint: `${base}/mcp`,
    gatewayToken: token.token,
    tenantKey: tnt,
    baseUrlSwap: {
      from: input.baseUrl ?? null,
      // OpenAI-compatible clients: point base_url here, auth with the gateway token.
      openai: `${base}/v1`,
      // Anthropic Messages clients: point base_url here (gateway speaks /v1/messages).
      anthropic: `${base}/v1`,
    },
    interactionMode,
  };
}
