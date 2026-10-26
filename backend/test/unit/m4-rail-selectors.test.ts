import { describe, it, expect } from 'vitest';
import { encodeFunctionData, encodeAbiParameters, parseAbi, toFunctionSelector } from 'viem';
import {
  decodeCall,
  classify,
  ruleKey,
  BRIDGE_SELECTORS,
  type CallRule,
  type GrantState,
} from '../../src/governed-call/index.js';
import { resolveRailDestination, CCIP_SELECTOR_TO_CHAIN } from '../../src/governed-call/rail-domains.js';
import { planDestGas, type GasRouteConfig, type GasSnapshot } from '../../src/chain/gas-planner.js';

/**
 * AQ-FND M-4 — the REAL rail decoders (D-5: CCTP v2 for the Base/Eth/Arb USDC legs,
 * Chainlink CCIP for every 0G leg): strict-canonical decode, bridge-family classify
 * (recipient pinned SELF — funds only land on the same-address far account), decoded
 * destination-domain extraction, and the G-9 DestGasPlan ladder mapping.
 */

const SELF = '0x' + '55'.repeat(20);
const ATTACKER = '0x' + 'bb'.repeat(20);
const USDC = '0x' + 'cc'.repeat(20);
const CCTP = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const CCIP_ROUTER = '0xd610b8f58689de7755947c05342a2dfac30ebd57';
const ZERO32 = `0x${'00'.repeat(32)}` as const;

const addr32 = (a: string): `0x${string}` => `0x${'00'.repeat(12)}${a.slice(2)}` as `0x${string}`;

const cctpAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const SEL_CCTP = toFunctionSelector(
  'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
).toLowerCase();

const ccipAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message)',
]);
const SEL_CCIP = toFunctionSelector(
  'function ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))',
).toLowerCase();

const OG_SELECTOR = '6892437333620424805'; // 0G Galileo (probed live)

function encCctp(over: Partial<{ amount: bigint; domain: number; recipient: `0x${string}`; caller: `0x${string}` }> = {}): string {
  return encodeFunctionData({
    abi: cctpAbi,
    functionName: 'depositForBurn',
    args: [
      over.amount ?? 1_000_000n,
      over.domain ?? 6, // Base Sepolia
      over.recipient ?? addr32(SELF),
      USDC as `0x${string}`,
      over.caller ?? ZERO32,
      500n,
      1000,
    ],
  });
}

function encCcip(over: Partial<{ selector: bigint; receiver: `0x${string}`; data: `0x${string}`; tokens: Array<{ token: `0x${string}`; amount: bigint }>; feeToken: `0x${string}`; extraArgs: `0x${string}` }> = {}): string {
  return encodeFunctionData({
    abi: ccipAbi,
    functionName: 'ccipSend',
    args: [
      over.selector ?? BigInt(OG_SELECTOR),
      {
        receiver: over.receiver ?? encodeAbiParameters([{ type: 'address' }], [SELF as `0x${string}`]),
        data: over.data ?? '0x',
        tokenAmounts: over.tokens ?? [{ token: USDC as `0x${string}`, amount: 777n }],
        feeToken: over.feeToken ?? ('0x' + '00'.repeat(20) as `0x${string}`),
        extraArgs: over.extraArgs ?? '0x',
      },
    ],
  });
}

describe('M-4 decodeCall — CCTP v2 depositForBurn (strict canonical)', () => {
  it('canonical: amount, bytes32 recipient, burnToken budget key, decoded destination domain', () => {
    const d = decodeCall(CCTP, 0n, encCctp());
    expect(d.reject).toBeUndefined();
    expect(d.args.amount).toBe(1_000_000n);
    expect(d.args.recipients).toEqual([SELF]);
    expect(d.args.spendToken).toBe(USDC);
    expect(d.args.bridgeDestination).toEqual({ kind: 'cctp_domain', value: '6' });
    expect(BRIDGE_SELECTORS.has(SEL_CCTP)).toBe(true);
  });

  it('nonzero destinationCaller (far mint gated behind a foreign key) → DecodeMismatch', () => {
    const d = decodeCall(CCTP, 0n, encCctp({ caller: addr32(ATTACKER) }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('dirty high bits on the bytes32 mintRecipient → DecodeMismatch', () => {
    const dirty = (`0x${'ff'.repeat(12)}${SELF.slice(2)}`) as `0x${string}`;
    const d = decodeCall(CCTP, 0n, encCctp({ recipient: dirty }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('riding msg.value on the nonpayable burn → DecodeMismatch', () => {
    const d = decodeCall(CCTP, 1n, encCctp());
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('truncated calldata → DecodeMismatch', () => {
    const d = decodeCall(CCTP, 0n, encCctp().slice(0, -64));
    expect(d.reject).toBe('DecodeMismatch');
  });
});

describe('M-4 decodeCall — CCIP ccipSend (strict canonical dynamic decoder)', () => {
  it('canonical: ONE tokenAmount, empty data/extraArgs, native fee; recipient/token/amount/selector decoded', () => {
    const d = decodeCall(CCIP_ROUTER, 42n, encCcip());
    expect(d.selector).toBe(SEL_CCIP);
    expect(d.reject).toBeUndefined();
    expect(d.args.recipients).toEqual([SELF]);
    expect(d.args.spendToken).toBe(USDC);
    expect(d.args.amount).toBe(777n);
    expect(d.args.bridgeDestination).toEqual({ kind: 'ccip_selector', value: OG_SELECTOR });
    expect(BRIDGE_SELECTORS.has(SEL_CCIP)).toBe(true);
  });

  it('two tokenAmounts → DecodeMismatch (one governable movement per leg)', () => {
    const d = decodeCall(CCIP_ROUTER, 42n, encCcip({ tokens: [
      { token: USDC as `0x${string}`, amount: 1n },
      { token: USDC as `0x${string}`, amount: 2n },
    ] }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('non-empty data payload → DecodeMismatch (no arbitrary far-chain payload)', () => {
    const d = decodeCall(CCIP_ROUTER, 42n, encCcip({ data: '0xdeadbeef' }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('non-empty extraArgs → DecodeMismatch (no gas-limit smuggling)', () => {
    const d = decodeCall(CCIP_ROUTER, 42n, encCcip({ extraArgs: '0x97a657c9' }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('ERC-20 feeToken → DecodeMismatch (fee must be native msg.value, metered on-chain)', () => {
    const d = decodeCall(CCIP_ROUTER, 0n, encCcip({ feeToken: USDC as `0x${string}` }));
    expect(d.reject).toBe('DecodeMismatch');
  });

  it('non-address receiver bytes (wrong length) → DecodeMismatch', () => {
    const d = decodeCall(CCIP_ROUTER, 42n, encCcip({ receiver: '0x1234' }));
    expect(d.reject).toBe('DecodeMismatch');
  });
});

describe('M-4 classify — the rails ride the SE-8 bridge arm', () => {
  const railRule = (target: string, selector: string): CallRule => ({
    target,
    selector,
    recipientMode: 'self',
    spenderSet: [],
    perCallCap: '1000000000',
    windowCapCall: '5000000000',
  });
  const grant = (target: string, selector: string): GrantState => ({
    rules: new Map([[ruleKey(target, selector), railRule(target, selector)]]),
    budgets: new Map([[USDC, '5000000000']]),
    allowlist: new Set<string>(),
    bridgeTargets: new Set([target]),
  });

  it('a granted, in-cap, self-recipient CCTP burn on an allowlisted rail is L1', () => {
    const c = classify(decodeCall(CCTP, 0n, encCctp()), grant(CCTP, SEL_CCTP), SELF);
    expect(c).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });

  it('a CCTP burn whose mintRecipient is NOT the same-address account is never L1', () => {
    const c = classify(decodeCall(CCTP, 0n, encCctp({ recipient: addr32(ATTACKER) })), grant(CCTP, SEL_CCTP), SELF);
    expect(c.lane).toBe('l2');
    expect((c as { novelty: string[] }).novelty).toContain('new_recipient');
  });

  it('a rail selector against a target OUTSIDE the bridge allowlist → forbidden', () => {
    const g = grant(CCTP, SEL_CCTP);
    g.bridgeTargets = new Set(['0x' + '99'.repeat(20)]);
    const c = classify(decodeCall(CCTP, 0n, encCctp()), g, SELF);
    expect(c).toEqual({ lane: 'forbidden', reason: 'bridge_not_allowlisted' });
  });

  it('a granted, in-cap, self-receiver ccipSend on the allowlisted router is L1 (fee rides msg.value)', () => {
    const c = classify(decodeCall(CCIP_ROUTER, 42n, encCcip()), grant(CCIP_ROUTER, SEL_CCIP), SELF);
    expect(c).toEqual({ lane: 'l1', reason: 'in_envelope' });
  });

  it('an over-cap token amount is L2 over_cap, never L1', () => {
    const g = grant(CCTP, SEL_CCTP);
    const c = classify(decodeCall(CCTP, 0n, encCctp({ amount: 2_000_000_000n })), g, SELF);
    expect(c.lane).toBe('l2');
    expect((c as { novelty: string[] }).novelty).toContain('over_cap');
  });

  it('a token with NO budget set is L2 over_budget (BudgetNotSet would revert on-chain)', () => {
    const g = grant(CCTP, SEL_CCTP);
    g.budgets = new Map();
    const c = classify(decodeCall(CCTP, 0n, encCctp()), g, SELF);
    expect(c.lane).toBe('l2');
    expect((c as { novelty: string[] }).novelty).toContain('over_budget');
  });
});

describe('M-4 rail-domains — protocol-constant destination resolution', () => {
  it('resolves CCTP domains to the three Sepolias', () => {
    expect(resolveRailDestination({ kind: 'cctp_domain', value: '0' })).toBe(11155111);
    expect(resolveRailDestination({ kind: 'cctp_domain', value: '3' })).toBe(421614);
    expect(resolveRailDestination({ kind: 'cctp_domain', value: '6' })).toBe(84532);
  });
  it('resolves CCIP selectors (incl. 0G Galileo) and refuses unknowns', () => {
    expect(resolveRailDestination({ kind: 'ccip_selector', value: OG_SELECTOR })).toBe(16602);
    expect(CCIP_SELECTOR_TO_CHAIN.get('16015286601757825753')).toBe(11155111);
    expect(resolveRailDestination({ kind: 'ccip_selector', value: '123456789' })).toBeNull();
    expect(resolveRailDestination({ kind: 'cctp_domain', value: '99' })).toBeNull();
    expect(resolveRailDestination({ kind: 'cctp_domain', value: 'not-a-number' })).toBeNull();
  });
});

describe('G-9 planDestGas — the ladder → DestGasPlan mapping (route enterability)', () => {
  const cfg: GasRouteConfig = { gasFloorWei: 100n, refuelWei: 500n, dexRouteAvailable: false };
  const snap = (over: Partial<GasSnapshot>): GasSnapshot => ({
    sessionNativeWei: 0n,
    accountNativeWei: 0n,
    spendableTokens: [],
    sessionKeyNativeAllowlisted: false,
    ...over,
  });

  it('has-native → prefunded with the real balance', () => {
    expect(planDestGas(cfg, snap({ sessionNativeWei: 150n }), 84532)).toEqual({
      destChainId: 84532, fundedWei: '150', source: 'prefunded',
    });
  });
  it('account-native → refuel', () => {
    expect(planDestGas(cfg, snap({ accountNativeWei: 600n, sessionKeyNativeAllowlisted: true }), 84532)).toEqual({
      destChainId: 84532, fundedWei: '500', source: 'refuel',
    });
  });
  it('swap-to-gas → refuel (the swap lands native first)', () => {
    expect(
      planDestGas({ ...cfg, dexRouteAvailable: true }, snap({ spendableTokens: [{ token: USDC as `0x${string}`, balance: 9n }] }), 16602),
    ).toEqual({ destChainId: 16602, fundedWei: '500', source: 'refuel' });
  });
  it('bootstrap-7702 → paymaster', () => {
    expect(
      planDestGas(
        { ...cfg, gasRepayDelegate: ('0x' + 'ab'.repeat(20)) as `0x${string}` },
        snap({ spendableTokens: [{ token: USDC as `0x${string}`, balance: 9n }] }),
        16602,
      ),
    ).toEqual({ destChainId: 16602, fundedWei: '500', source: 'paymaster' });
  });
  it('ask-owner → null: the route is NOT enterable (G-9 by construction)', () => {
    expect(planDestGas(cfg, snap({}), 16602)).toBeNull();
  });
});
