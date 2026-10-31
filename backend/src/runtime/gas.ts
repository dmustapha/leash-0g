/**
 * AQ-FND M-3 — the runtime adapters that feed the ratified self-funding gas ladder
 * (`planGas`, `backend/src/chain/gas-planner.ts`). `planGas` is pure; these build its
 * two inputs from LIVE server-read state (never model text):
 *
 *   buildGasRouteConfig(chainConfig)  — the per-chain route capabilities (pure).
 *   buildGasSnapshot(...)             — the live balances + spendability (I/O via chain).
 *
 * D-4 (LEASH never sponsors): the ladder either self-funds or asks the owner. A token
 * only counts as `spendable` when its on-chain V6 asset policy is ENABLED and the repay
 * recipient (the ops relayer) is an allowlisted payee for it — otherwise the rung-4
 * bootstrap could not repay the relayer in that token, so it must not be offered.
 */
import type { Address } from 'viem';
import type { ChainConfig } from '../chain/registry.js';
import type { GasRouteConfig, GasSnapshot } from '../chain/gas-planner.js';
import type { RuntimeChain } from './session-chain.js';

/** The ladder decision + its inputs, so the runtime can trace exactly what it read. */
export interface GasAssessment {
  cfg: GasRouteConfig;
  snap: GasSnapshot;
}

/**
 * Map a chain's static config onto the route capabilities the ladder reasons over.
 * Pure. `dexRouteAvailable` is derived from a configured canonical router (FALSE on
 * 0G Galileo testnet — P-GAS-3). `refuelWei` is the chain-priced session-key dust
 * (falls back to the global default when the chain does not override it).
 */
export function buildGasRouteConfig(chainConfig: ChainConfig, globalDustWei: bigint): GasRouteConfig {
  return {
    gasFloorWei: chainConfig.gasFloorWei,
    refuelWei: chainConfig.sessionGasDustWei ?? globalDustWei,
    dexRouteAvailable: Boolean(chainConfig.canonical?.router),
    ...(chainConfig.gasRepayDelegateAddr
      ? { gasRepayDelegate: chainConfig.gasRepayDelegateAddr as Address }
      : {}),
  };
}

/**
 * Read the live gas snapshot for a (session key, account) on the agent's chain. The
 * token leg is filtered to SPENDABLE tokens only: policy enabled AND the repay
 * recipient (ops relayer) allowlisted as a payee — the rung-4 precondition (D-4). A
 * token held with no enabled policy / no relayer payee is NOT spendable here, so the
 * ladder falls to ask-owner rather than offering a bootstrap that cannot repay.
 *
 * `getAssetPolicy` is optional on the chain surface (test fakes may omit it); when
 * absent, no token is spendable (fail-closed) and a zero-native agent asks the owner.
 */
export async function buildGasSnapshot(opts: {
  chain: RuntimeChain;
  accountAddr: string;
  sessionKeyAddr: string;
  /** The ERC-20 the goal spends (the top-up + repay token), or null for a native cycle. */
  token: string | null;
  /** The ops relayer that fronts + is repaid gas — must be an allowlisted payee of `token`. */
  opsRelayerAddr: string;
}): Promise<GasSnapshot> {
  const { chain, accountAddr, sessionKeyAddr, token, opsRelayerAddr } = opts;
  const [sessionNativeWei, accountNativeWei, sessionKeyNativeAllowlisted] = await Promise.all([
    chain.getBalance(sessionKeyAddr),
    chain.getBalance(accountAddr),
    isNativePayee(chain, accountAddr, sessionKeyAddr),
  ]);

  const spendableTokens: Array<{ token: Address; balance: bigint }> = [];
  if (token && chain.getAssetPolicy) {
    const [balance, assetPolicy] = await Promise.all([
      chain.getErc20Balance(token, accountAddr),
      chain.getAssetPolicy(accountAddr, token, [opsRelayerAddr]),
    ]);
    // Spendable ⇔ enabled policy AND the relayer is a payee (so rung-4 can repay).
    const relayerIsPayee = assetPolicy.allowedPayees.includes(opsRelayerAddr.toLowerCase());
    if (balance > 0n && assetPolicy.enabled && relayerIsPayee) {
      spendableTokens.push({ token: token.toLowerCase() as Address, balance });
    }
  }

  return { sessionNativeWei, accountNativeWei, spendableTokens, sessionKeyNativeAllowlisted };
}

/** Is the session key an allowlisted NATIVE payee (rung-2 precondition)? Fail-closed. */
async function isNativePayee(chain: RuntimeChain, accountAddr: string, sessionKeyAddr: string): Promise<boolean> {
  if (!chain.getAssetPolicy) return false;
  const nativePolicy = await chain.getAssetPolicy(
    accountAddr,
    '0x0000000000000000000000000000000000000000',
    [sessionKeyAddr],
  );
  return nativePolicy.allowedPayees.includes(sessionKeyAddr.toLowerCase());
}
