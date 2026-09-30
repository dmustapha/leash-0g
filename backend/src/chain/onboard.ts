import type { Pool } from 'pg';
import type { AgentRow } from '../types.js';
import type { ChainOps } from '../server.js';
import {
  insertChainDeployment,
  getChainDeployment,
  type ChainDeploymentRow,
} from '../store/chain-deployments.js';

/**
 * SE-7 (E-7) — SECOND-CHAIN ONBOARDING: replay the agent's PERSISTED
 * construction tuple (`agents.account_create_tuple`, byte-exact — it is baked
 * into the CREATE2 initcode) + the persisted `agents.account_salt` on another
 * registered chain, so the account lands at the SAME address (SD-E9). The
 * production consumer of the SE-6 reuse path (`deployAndRegister({accountSalt})`,
 * W1/L-02).
 *
 * REFUSAL-FIRST: before any mint, the target chain's CREATE2 prediction for the
 * persisted tuple MUST equal the persisted `agents.account_addr`. A mutated /
 * reconstructed tuple (time-derived expiry, rotated guardian, reordered
 * allowlist) predicts a DIFFERENT address and is REFUSED — never minted, never
 * recorded. This check is the onboarding-shaped half of spec §8's CREATE2
 * address-spoof guard (the full pre-routing `assertSameAddress` is SE-8's).
 */

export type OnboardRefusalReason =
  | 'not_v4'
  | 'no_persisted_tuple'
  | 'home_chain'
  | 'already_onboarded'
  | 'guardian_mismatch'
  | 'tuple_prediction_mismatch'
  | 'mint_address_mismatch';

export class OnboardRefusedError extends Error {
  constructor(
    public readonly reason: OnboardRefusalReason,
    detail: string,
  ) {
    super(`second-chain onboard REFUSED (${reason}): ${detail}`);
    this.name = 'OnboardRefusedError';
  }
}

/** The persisted canonical tuple shape (ops.ts accountCreateTuple, JSON). */
export interface PersistedCreateTuple {
  ownerAddr: string;
  guardianAddr: string;
  sessionKeyAddr: string;
  policy: { perTransferCap: string; windowCap: string; windowSeconds: number; expiresAt: number };
  allowlist: string[];
  timelockDelay: number;
  settlementToken: string;
  tokenPolicy: { perTransferCapToken: string; windowCapToken: string };
}

/** The registry surface the onboard needs (structural, so tests fake it cheaply). */
export interface OnboardChainOps extends ChainOps {
  guardianAddress: string;
  predictAccountV4(input: {
    ownerAddr: string;
    sessionKeyAddr: string;
    guardianAddr?: string;
    policy: { perTransferCap: bigint; windowCap: bigint; windowSeconds: number; expiresAt: number };
    allowlist: string[];
    timelockDelay: number;
    settlementToken?: string;
    tokenPolicy?: { perTransferCapToken: bigint; windowCapToken: bigint };
    accountSalt: string;
  }): Promise<string>;
}

/**
 * Validate + parse the persisted create tuple. Exported for the SE-8 bridge
 * pre-routing gate (`runtime/bridge-gate.ts`), which replays the same byte-exact
 * tuple into `assertSameAddress` before any cross-chain funds route.
 */
export function parsePersistedTuple(agent: AgentRow): PersistedCreateTuple {
  const t = agent.accountCreateTuple as unknown as PersistedCreateTuple | null;
  if (
    !t ||
    typeof t.ownerAddr !== 'string' ||
    typeof t.guardianAddr !== 'string' ||
    typeof t.sessionKeyAddr !== 'string' ||
    !t.policy ||
    !Array.isArray(t.allowlist) ||
    typeof t.timelockDelay !== 'number' ||
    typeof t.settlementToken !== 'string' ||
    !t.tokenPolicy
  ) {
    throw new OnboardRefusedError(
      'no_persisted_tuple',
      'agent has no persisted account_create_tuple (pre-SE-6 v4 or legacy account) — cannot replay byte-exact',
    );
  }
  return t;
}

/** The zero address means "native-only account" in the constructor wire. */
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export async function onboardAgentToChain(
  deps: { pool: Pool; getChainOps: (chainId: number) => OnboardChainOps },
  agent: AgentRow,
  targetChainId: number,
): Promise<{ deployment: ChainDeploymentRow; adopted: boolean; alreadyOnboarded: boolean }> {
  if (agent.accountVersion !== 4 || !agent.accountSalt) {
    throw new OnboardRefusedError('not_v4', 'only deterministic V4 accounts (with a persisted salt) can onboard to another chain');
  }
  if (targetChainId === agent.chainId) {
    throw new OnboardRefusedError('home_chain', `chain ${targetChainId} is the agent's home chain`);
  }
  const existing = await getChainDeployment(deps.pool, agent.id, targetChainId);
  if (existing) {
    // Idempotent: the presence row already exists — return it, mint nothing.
    return { deployment: existing, adopted: existing.adopted, alreadyOnboarded: true };
  }
  const tuple = parsePersistedTuple(agent);
  // Default-deny for unregistered chains happens inside getChainOps (E-11).
  const ops = deps.getChainOps(targetChainId);
  // The mint lane's guardian key must BE the create-time guardian — the tuple
  // is baked into the initcode, so a rotated guardian cannot reproduce the
  // address. Refuse legibly instead of minting a divergent account.
  if (ops.guardianAddress.toLowerCase() !== tuple.guardianAddr.toLowerCase()) {
    throw new OnboardRefusedError(
      'guardian_mismatch',
      `target-chain guardian lane ${ops.guardianAddress.toLowerCase()} != create-time guardian ${tuple.guardianAddr.toLowerCase()}`,
    );
  }
  const predictInput = {
    ownerAddr: tuple.ownerAddr,
    sessionKeyAddr: tuple.sessionKeyAddr,
    guardianAddr: tuple.guardianAddr,
    policy: {
      perTransferCap: BigInt(tuple.policy.perTransferCap),
      windowCap: BigInt(tuple.policy.windowCap),
      windowSeconds: tuple.policy.windowSeconds,
      expiresAt: tuple.policy.expiresAt,
    },
    allowlist: tuple.allowlist,
    timelockDelay: tuple.timelockDelay,
    ...(tuple.settlementToken !== ZERO_ADDR ? { settlementToken: tuple.settlementToken } : {}),
    tokenPolicy: {
      perTransferCapToken: BigInt(tuple.tokenPolicy.perTransferCapToken),
      windowCapToken: BigInt(tuple.tokenPolicy.windowCapToken),
    },
    accountSalt: agent.accountSalt,
  };
  // REFUSAL-FIRST: the target chain's prediction for the persisted tuple must
  // equal the persisted account address. Any drift = mutated/reconstructed
  // tuple = refuse BEFORE minting anything.
  const predicted = (await ops.predictAccountV4(predictInput)).toLowerCase();
  if (predicted !== agent.accountAddr.toLowerCase()) {
    throw new OnboardRefusedError(
      'tuple_prediction_mismatch',
      `target-chain CREATE2 prediction ${predicted} != persisted account ${agent.accountAddr.toLowerCase()} — tuple/salt drift, refusing to mint`,
    );
  }
  const result = await ops.deployAndRegister({
    ownerAddr: tuple.ownerAddr,
    sessionKeyAddr: tuple.sessionKeyAddr,
    auditPubKey: agent.auditPubkey,
    name: agent.name,
    accountVersion: 4,
    policy: predictInput.policy,
    allowlist: tuple.allowlist,
    timelockDelay: tuple.timelockDelay,
    ...(tuple.settlementToken !== ZERO_ADDR ? { settlementToken: tuple.settlementToken } : {}),
    tokenPolicy: predictInput.tokenPolicy,
    accountSalt: agent.accountSalt,
  });
  // Belt-and-braces: the ops layer already refuses an off-prediction mint;
  // re-assert against the PERSISTED address before recording anything.
  if (result.accountAddr.toLowerCase() !== agent.accountAddr.toLowerCase()) {
    throw new OnboardRefusedError(
      'mint_address_mismatch',
      `minted ${result.accountAddr.toLowerCase()} != persisted ${agent.accountAddr.toLowerCase()} — not recording`,
    );
  }
  let deployment: ChainDeploymentRow;
  try {
    deployment = await insertChainDeployment(deps.pool, {
      agentId: agent.id,
      chainId: targetChainId,
      accountAddr: result.accountAddr,
      createTx: result.createTx,
      registerTx: result.registerTx,
      chainAgentId: result.chainAgentId,
      adopted: result.adopted,
    });
  } catch (err) {
    // sec L-01 (SE-7): two concurrent onboards can both pass the pre-check;
    // CREATE2 makes the double-mint harmless (the second adopts the same
    // address) and UNIQUE(agent_id, chain_id) refuses the double record —
    // resolve the race to the idempotent shape, never a 500.
    if ((err as { code?: string }).code === '23505') {
      const raced = await getChainDeployment(deps.pool, agent.id, targetChainId);
      if (raced) return { deployment: raced, adopted: raced.adopted, alreadyOnboarded: true };
    }
    throw err;
  }
  return { deployment, adopted: result.adopted, alreadyOnboarded: false };
}
