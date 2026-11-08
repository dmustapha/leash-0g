import { toFunctionSelector } from 'viem';
import type { CallRule, CapabilityPreset, DenyTrigger, PresetKey } from './types.js';

/**
 * Capability presets (D-9) — the broad-grant UX under a default-deny posture
 * (`07 S28`). A preset is OFF-CHAIN SUGAR: applying one expands to a batch of
 * owner `proposeCallRule` proposals (loosen-timelocked) + per-token budgets +
 * the JIT deny-list layered on top. A preset can NEVER grant a deny-list action
 * without JIT and adds NO new goal role (generality guard) — both Gate-② checks.
 *
 * Presets are network-agnostic: capabilities reference LOGICAL target/token keys
 * resolved to concrete deployed addresses via a `TargetCatalog` at apply time
 * (mock targets on 0G testnet, decision (c); real protocols are Stage E).
 */

export type TargetKey = 'router' | 'vault' | 'settlement_token' | 'wrapped_native';

/** Per-network resolution of logical keys → concrete lowercased addresses. */
export interface TargetCatalog {
  router?: string;
  vault?: string;
  settlement_token?: string;
  /** the chain's WETH9 (`ChainConfig.gasSwap.wrappedNative`) — the swap-to-gas output + unwrap target. */
  wrapped_native?: string;
}

interface Capability {
  target: TargetKey;
  signature: string;
  recipientMode: 'self' | 'allowlist';
  /** spender keys for approve-shaped selectors (resolved to addresses). */
  spenders?: TargetKey[];
  perCallCap: string;
  windowCapCall: string;
}

interface PresetDef {
  key: PresetKey;
  label: string;
  description: string;
  capabilities: Capability[];
  /** per-token cumulative outflow budgets (spine, D-3) referencing token keys. */
  budgets: { token: TargetKey; windowCap: string }[];
  /** always-JIT triggers ON TOP of the global deny-list. */
  extraDeny?: DenyTrigger[];
}

/**
 * Global JIT deny-list (brief §6) — ALWAYS forces L2 even inside a standing grant.
 * A preset can never suppress these; they are the non-negotiable "must ASK" set.
 */
export const GLOBAL_DENY_LIST: readonly DenyTrigger[] = [
  'new_spender',
  'unlimited_approval',
  'new_recipient',
  'bridge',
  'self_edit',
  'over_budget',
];

const PRESETS: readonly PresetDef[] = [
  {
    key: 'defi_trader',
    label: 'DeFi Trader',
    description: 'Swap and add liquidity on a fixed protocol + token set, within a daily budget. Asks you before any new spender, token, bridge, or external wallet.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['router'], perCallCap: '100000000', windowCapCall: '500000000' },
      { target: 'router', signature: 'function swap(address,address,uint256,uint256,address,uint256)', recipientMode: 'self', perCallCap: '100000000', windowCapCall: '500000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '500000000' }],
  },
  {
    key: 'yield_manager',
    label: 'Yield Manager',
    description: 'Deposit into a designated vault list, within a daily budget. Lending, borrowing and withdrawals are not supported yet. Asks you before a new vault, a new protocol, or a bridge.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['vault'], perCallCap: '100000000', windowCapCall: '500000000' },
      { target: 'vault', signature: 'function deposit(uint256,address)', recipientMode: 'self', perCallCap: '100000000', windowCapCall: '500000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '500000000' }],
  },
  {
    key: 'treasury_topper',
    label: 'Treasury Topper',
    description: 'Move native + token funds to a fixed set of YOUR OWN wallets only. Asks you before any new recipient — the #1 thing an agent should never do alone.',
    capabilities: [
      { target: 'settlement_token', signature: 'function transfer(address,uint256)', recipientMode: 'allowlist', perCallCap: '50000000', windowCapCall: '200000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '200000000' }],
  },
  {
    key: 'dca',
    label: 'DCA Bot',
    description: 'One fixed input→output swap route on a cadence. Asks you before a token, amount, or schedule change, or before selling.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['router'], perCallCap: '20000000', windowCapCall: '140000000' },
      { target: 'router', signature: 'function swap(address,address,uint256,uint256,address,uint256)', recipientMode: 'self', perCallCap: '20000000', windowCapCall: '140000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '140000000' }],
  },
  {
    key: 'rebalancer',
    label: 'Portfolio Rebalancer',
    description: 'Swaps within a fixed basket, with drift and turnover caps. Asks you before any basket change.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['router'], perCallCap: '100000000', windowCapCall: '500000000' },
      { target: 'router', signature: 'function swap(address,address,uint256,uint256,address,uint256)', recipientMode: 'self', perCallCap: '100000000', windowCapCall: '500000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '500000000' }],
  },
  {
    key: 'leverage_adv',
    label: 'Vault deposits, tighter limits (advanced)',
    description: 'Deposits into a designated vault list with smaller limits. Borrowing and repaying are not supported yet; any borrow-style call always asks you first.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['vault'], perCallCap: '50000000', windowCapCall: '250000000' },
      { target: 'vault', signature: 'function deposit(uint256,address)', recipientMode: 'self', perCallCap: '50000000', windowCapCall: '250000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '250000000' }],
  },
  {
    // AQ-FND M-3 inc-3a: the rules the swap-to-gas executor (`buildGasSwapCalls`) needs.
    // The owner ALSO needs (not call rules, so not expressible here): the session key as an
    // allowlisted NATIVE payee (the final account->session-key refuel), and the WETH9 /
    // router in the chain's protocol allowlist. perCallCap bounds one gas swap (e.g. 20 USDC).
    key: 'gas_swap',
    label: 'Gas Swap',
    description: 'Let the agent sell a small, fixed amount of its settlement token for the chain\'s native gas coin, only through the chain\'s Uniswap router, and only into its own account. Asks you before any other swap, token, or recipient.',
    capabilities: [
      { target: 'settlement_token', signature: 'function approve(address,uint256)', recipientMode: 'self', spenders: ['router'], perCallCap: '20000000', windowCapCall: '100000000' },
      { target: 'router', signature: 'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', recipientMode: 'self', perCallCap: '20000000', windowCapCall: '100000000' },
      { target: 'wrapped_native', signature: 'function withdraw(uint256)', recipientMode: 'self', perCallCap: '1000000000000000000', windowCapCall: '5000000000000000000' },
    ],
    budgets: [{ token: 'settlement_token', windowCap: '100000000' }],
  },
];

const BY_KEY = new Map<PresetKey, PresetDef>(PRESETS.map((p) => [p.key, p]));

export function presetKeys(): PresetKey[] {
  return PRESETS.map((p) => p.key);
}

export function getPresetDef(key: PresetKey): PresetDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Expand a preset to concrete grant proposals against a network's TargetCatalog.
 * Returns `null` when a referenced target/token is missing from the catalog (a
 * preset must be fully resolvable — never a partial grant). All addresses are
 * lowercased; selectors are computed canonically.
 */
export function expandPreset(key: PresetKey, catalog: TargetCatalog): CapabilityPreset | null {
  const def = BY_KEY.get(key);
  if (!def) return null;

  const resolve = (k: TargetKey): string | undefined => {
    const v = catalog[k];
    return v ? v.toLowerCase() : undefined;
  };

  const rules: CallRule[] = [];
  for (const cap of def.capabilities) {
    const target = resolve(cap.target);
    if (!target) return null;
    const spenderSet: string[] = [];
    for (const sk of cap.spenders ?? []) {
      const s = resolve(sk);
      if (!s) return null;
      spenderSet.push(s);
    }
    rules.push({
      target,
      selector: toFunctionSelector(cap.signature).toLowerCase(),
      recipientMode: cap.recipientMode,
      spenderSet,
      perCallCap: cap.perCallCap,
      windowCapCall: cap.windowCapCall,
    });
  }

  const budgets: { token: string; windowCap: string }[] = [];
  for (const b of def.budgets) {
    const token = resolve(b.token);
    if (!token) return null;
    budgets.push({ token, windowCap: b.windowCap });
  }

  return {
    key: def.key,
    label: def.label,
    description: def.description,
    rules,
    budgets,
    denyList: [...GLOBAL_DENY_LIST, ...(def.extraDeny ?? [])],
  };
}
