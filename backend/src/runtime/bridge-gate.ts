import { type AgentRow, assertNativeAgent } from '../types.js';
import type { ChainRegistry } from '../chain/registry.js';
import { SameAddressMismatchError, UnregisteredChainError } from '../chain/registry.js';
import { OnboardRefusedError, parsePersistedTuple } from '../chain/onboard.js';

/**
 * SE-8 — the HARD pre-routing gate (SE-7 gate carry #1; spec §3b bridging).
 * Before ANY governed bridge call routes funds off-chain-A, this gate must PASS:
 *
 *  1. the bridge target is in the chain's owner-configured `bridgeAllowlist`
 *     (belt-and-braces with classify's `bridge_not_allowlisted`);
 *  2. the bridge has a configured DESTINATION chain, and that chain is
 *     registered (default-deny, E-11 — a bridge whose far leg we cannot verify
 *     is never routable);
 *  3. `ChainRegistry.assertSameAddress` — the SE-6 cross-chain CREATE2
 *     verification, in its FULL production shape: the persisted create tuple +
 *     salt predict the SAME address on home + destination, the prediction is
 *     BOUND to the persisted `agents.account_addr` (`expectedAccountAddr`), and
 *     the home chain hosts deployed account bytecode (`homeChainId`). This is
 *     that function's FIRST production caller (closes SE-6 W1).
 *
 * Fail-closed: ANY divergence throws (`BridgeRoutingRefusedError` wrapping the
 * typed cause) and the runtime stands down, traced — far-chain funds can only
 * ever land on the agent's own same-address leashed account.
 */
export class BridgeRoutingRefusedError extends Error {
  constructor(
    public readonly reason:
      | 'bridge_not_allowlisted'
      | 'no_destination'
      | 'destination_unregistered'
      | 'destination_chainid_mismatch'
      | 'no_persisted_tuple'
      | 'same_address_refused',
    detail: string,
  ) {
    super(`bridge routing REFUSED (${reason}): ${detail}`);
    this.name = 'BridgeRoutingRefusedError';
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export async function assertBridgeRoutable(
  registry: ChainRegistry,
  agent: AgentRow,
  bridgeTarget: string,
): Promise<{ destinationChainId: number; verifiedAddr: string }> {
  // SF-2: bridge routing is native-only (requires the agent's on-chain account).
  assertNativeAgent(agent);
  const target = bridgeTarget.toLowerCase();
  const cfg = registry.getChainConfig(agent.chainId); // default-deny home chain
  const allow = (cfg.bridgeAllowlist ?? []).map((a) => a.toLowerCase());
  if (!allow.includes(target)) {
    throw new BridgeRoutingRefusedError(
      'bridge_not_allowlisted',
      `bridge ${target} is not in chain ${agent.chainId}'s bridge allowlist`,
    );
  }
  const destinationChainId = cfg.bridgeDestinations?.[target];
  if (destinationChainId === undefined) {
    throw new BridgeRoutingRefusedError(
      'no_destination',
      `bridge ${target} has no configured destination chain — far leg unverifiable`,
    );
  }
  try {
    registry.getChainConfig(destinationChainId);
  } catch (err) {
    if (err instanceof UnregisteredChainError) {
      throw new BridgeRoutingRefusedError(
        'destination_unregistered',
        `destination chain ${destinationChainId} is not registered (default-deny)`,
      );
    }
    throw err;
  }
  // SE-9 (L-02): cross-check the destination RPC's self-reported chain id against
  // the configured destination id — destination-RPC trust is now self-verifying,
  // not an operator-config boundary. A mis-pointed destination RPC (wrong chain)
  // is refused BEFORE any same-address verification or routing.
  const reportedDestId = await registry.getChainOps(destinationChainId).getChainId();
  if (reportedDestId !== destinationChainId) {
    throw new BridgeRoutingRefusedError(
      'destination_chainid_mismatch',
      `destination RPC reports chain ${reportedDestId}, configured ${destinationChainId} — refusing (L-02)`,
    );
  }
  // Stage F′ (FP-4 P1): V4 (governed-calldata) + V5 (governed-signing) are both
  // deterministic CREATE2 accounts eligible to bridge; legacy v2 is not.
  const deterministic = agent.accountVersion === 4 || agent.accountVersion === 5;
  if (!deterministic || !agent.accountSalt) {
    throw new BridgeRoutingRefusedError(
      'no_persisted_tuple',
      'only deterministic V4/V5 accounts (persisted salt + tuple) can bridge',
    );
  }
  let tuple;
  try {
    tuple = parsePersistedTuple(agent);
  } catch (err) {
    if (err instanceof OnboardRefusedError) {
      throw new BridgeRoutingRefusedError('no_persisted_tuple', err.message);
    }
    throw err;
  }
  try {
    const verifiedAddr = await registry.assertSameAddress({
      ownerAddr: tuple.ownerAddr,
      accountSalt: agent.accountSalt,
      create: {
        ownerAddr: tuple.ownerAddr,
        sessionKeyAddr: tuple.sessionKeyAddr,
        guardianAddr: tuple.guardianAddr, // create-time guardian, never the lane key (M-01)
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
      },
      chainIds: [agent.chainId, destinationChainId],
      expectedAccountAddr: agent.accountAddr,
      homeChainId: agent.chainId,
      // FP-4: V5 verifies the pinned singletons + off-chain predict (else V4 factory).
      accountVersion: agent.accountVersion === 5 ? 5 : 4,
      // RULING-A active anchor (Gate-② W-02): bind to the persisted initcode hash for V5 agents.
      ...(agent.accountVersion === 5 && agent.initCodeHash ? { initCodeHash: agent.initCodeHash } : {}),
    });
    return { destinationChainId, verifiedAddr };
  } catch (err) {
    if (err instanceof SameAddressMismatchError) {
      throw new BridgeRoutingRefusedError('same_address_refused', err.message);
    }
    throw err;
  }
}
