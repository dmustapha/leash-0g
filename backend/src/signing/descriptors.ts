import type { SigningDescriptor } from './types.js';

/**
 * FP-3 — the REAL per-chain governed-signing descriptors (C-02 reopened). Each descriptor is a
 * reviewed protocol onboarding: a decode spec + role triad bound to a chainId + verifyingContract
 * (N-01). All leaves are static words (N-02 recurses through the one nested group). Adding a protocol
 * is a descriptor + an owner grant — no code path changes (FP-e).
 *
 * Two families seeded with VERIFIED mainnet-style testnet addresses (on-chain confirmed 2026-10-07):
 *   - ERC-2612 permit (flat) on the real Circle testnet USDC tokens — Base/Arb/Eth Sepolia. 0G has no
 *     permit-enabled token, so its signing lane is Permit2-only.
 *   - Permit2 AllowanceTransfer `PermitSingle` (ONE-LEVEL NESTED) on the canonical Permit2 — all 4
 *     chains. This is the FP-3 nested achievement: the governed `amount` lives inside `PermitDetails`
 *     and is still capped because the wall reads it as a leaf (see LeashAccountV5 `_signingStructHash`).
 *
 * The descriptor-id scheme keeps the FP-2 built-in (id 1) intact and namespaces the real seeds:
 *   10..19 = ERC-2612 USDC per chain · 20..29 = Permit2 PermitSingle per chain.
 */

/** Canonical Permit2 (deterministic deploy — same address every EVM chain; verified live on all 4). */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const CHAIN = { zeroG: 16602, baseSepolia: 84532, arbSepolia: 421614, ethSepolia: 11155111 } as const;

/** Real Circle testnet USDC (EIP-2612 `permit`) — address + the EXACT EIP-712 domain name per chain
 * (Base/Eth report "USDC", Arb reports "USD Coin"; all version "2"). The computed domainSeparator is
 * asserted == the on-chain `DOMAIN_SEPARATOR()` in the descriptor test (N-01 / R-4). */
const USDC = {
  baseSepolia: { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', name: 'USDC' },
  arbSepolia: { token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', name: 'USD Coin' },
  ethSepolia: { token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', name: 'USDC' },
} as const;

function erc2612Descriptor(
  descriptorId: number,
  key: string,
  chainId: number,
  token: string,
  name: string,
): SigningDescriptor {
  return {
    descriptorId,
    key,
    label: 'USDC ERC-2612 permit',
    protocol: 'ERC-2612 Permit',
    domain: { name, version: '2', chainId, verifyingContract: token },
    primaryType: 'Permit',
    // Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)
    fields: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    roles: { spender: 'spender', amount: 'value', deadline: 'deadline' },
    sensitive: false,
  };
}

/**
 * Permit2 AllowanceTransfer `PermitSingle` — ONE-LEVEL NESTED (FP-3). Leaf order (pre-order):
 *   details.token, details.amount(uint160), details.expiration(uint48), details.nonce(uint48),
 *   spender, sigDeadline.
 * Roles: spender=`spender`, amount=`amount` (the NESTED allowance — capped via the leaf read),
 * deadline=`sigDeadline`. `expiration` is the secondary expiry leaf bounded to the owner window (R-2).
 */
function permit2SingleDescriptor(descriptorId: number, key: string, chainId: number): SigningDescriptor {
  return {
    descriptorId,
    key,
    label: 'Permit2 allowance permit',
    protocol: 'Permit2 AllowanceTransfer',
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }, // NO version
    primaryType: 'PermitSingle',
    fields: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    nested: {
      memberName: 'details',
      structType: 'PermitDetails',
      subFields: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    roles: { spender: 'spender', amount: 'amount', deadline: 'sigDeadline' },
    expiryRole: 'expiration',
    sensitive: false,
  };
}

/**
 * FP-4 Slice-4 — CoW Protocol `GPv2Order` (the FIRST `kind: 'order'` family). GPv2Settlement is the EIP-712
 * `verifyingContract` and is DETERMINISTIC on every CoW chain. The three enum fields (`kind`/
 * `sellTokenBalance`/`buyTokenBalance`) are declared EIP-712 `string` with the §3a `preHashedConstant`
 * override so `descriptorTypeHash` reproduces CoW's real `ORDER_TYPE_HASH` while each submitted leaf stays
 * the pinned pre-hashed word (`keccak256("sell")`/`keccak256("erc20")`). `appData` is a real `bytes32` pinned
 * to the ZERO hash ("no appData / no CIP-7 hook"). The wall hard-bounds the order (sellToken==budget token,
 * buyToken wall-pinned, receiver==self, cap on sellAmount+feeAmount); `sensitive:false` (parity, G10).
 */
export const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
/** CoW "no appData / no hooks" — the zero bytes32 (asserted == SigningLib `COW_APPDATA_NONE` on-chain). */
export const COW_APPDATA_NONE = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Sepolia (11155111) tokens for the seeded pair — sell WETH → buy USDC (G6: live CoW testnet; live-exec
 *  out of scope — the descriptor is structurally valid regardless of a live settlement on a given chain). */
const SEPOLIA_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
const SEPOLIA_USDC = USDC.ethSepolia.token;

function cowOrderDescriptor(
  descriptorId: number,
  key: string,
  chainId: number,
  sellToken: string,
  buyToken: string,
): SigningDescriptor {
  return {
    descriptorId,
    key,
    label: 'CoW sell order',
    protocol: 'CoW Protocol GPv2Order',
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT },
    primaryType: 'Order',
    kind: 'order',
    // GPv2Order — the 12 fields in canonical EIP-712 order (positions are FIXED and asserted on-chain).
    fields: [
      { name: 'sellToken', type: 'address' },
      { name: 'buyToken', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'sellAmount', type: 'uint256' },
      { name: 'buyAmount', type: 'uint256' },
      { name: 'validTo', type: 'uint32' },
      { name: 'appData', type: 'bytes32' },
      { name: 'feeAmount', type: 'uint256' },
      { name: 'kind', type: 'string', preHashedConstant: true },
      { name: 'partiallyFillable', type: 'bool' },
      { name: 'sellTokenBalance', type: 'string', preHashedConstant: true },
      { name: 'buyTokenBalance', type: 'string', preHashedConstant: true },
    ],
    roles: { amount: 'sellAmount', deadline: 'validTo' }, // NO spender (I-1)
    orderRoles: { receiver: 'receiver', fee: 'feeAmount', sellToken: 'sellToken' },
    constantPins: {
      sellToken: sellToken.toLowerCase(),
      buyToken: buyToken.toLowerCase(),
      feeAmount: 0n,
      appData: COW_APPDATA_NONE,
      kind: 'sell', // pre-image string — hashed to keccak256("sell") == on-chain COW_KIND_SELL
      partiallyFillable: false,
      sellTokenBalance: 'erc20', // pre-image string — hashed to keccak256("erc20") == COW_BAL_ERC20
      buyTokenBalance: 'erc20',
    },
    sensitive: false,
  };
}

/** The real FP-3 descriptor seed (appended to the FP-2 built-in id 1). */
export const FP3_DESCRIPTORS: readonly SigningDescriptor[] = [
  erc2612Descriptor(10, 'erc2612.usdc.base', CHAIN.baseSepolia, USDC.baseSepolia.token, USDC.baseSepolia.name),
  erc2612Descriptor(11, 'erc2612.usdc.arb', CHAIN.arbSepolia, USDC.arbSepolia.token, USDC.arbSepolia.name),
  erc2612Descriptor(12, 'erc2612.usdc.eth', CHAIN.ethSepolia, USDC.ethSepolia.token, USDC.ethSepolia.name),
  permit2SingleDescriptor(20, 'permit2.single.0g', CHAIN.zeroG),
  permit2SingleDescriptor(21, 'permit2.single.base', CHAIN.baseSepolia),
  permit2SingleDescriptor(22, 'permit2.single.arb', CHAIN.arbSepolia),
  permit2SingleDescriptor(23, 'permit2.single.eth', CHAIN.ethSepolia),
  // FP-4 Slice-4 — CoW GPv2Order; descriptor-id namespace 30..39 (one per chain). Sepolia seeded first (G6).
  cowOrderDescriptor(30, 'cow.order.eth', CHAIN.ethSepolia, SEPOLIA_WETH, SEPOLIA_USDC),
];

/** The on-chain `DOMAIN_SEPARATOR()` each USDC token returns (verified live) — asserted in the
 * descriptor test so a wrong name/version can never silently ship (N-01 / FP-3 review R-4). */
export const USDC_ONCHAIN_DOMAIN_SEPARATOR: Record<number, `0x${string}`> = {
  10: '0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818', // Base 84532
  11: '0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb', // Arb 421614
  12: '0xb90e5057db141a932946e64d09ccb7ffc9b00bd79fec26f698d29af0c83320a6', // Eth 11155111
};
