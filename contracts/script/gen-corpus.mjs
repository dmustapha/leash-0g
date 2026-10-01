// D-15 differential decode oracle — corpus generator.
// viem is the TRUSTED off-chain decoder. This script emits real-shaped canonical
// calldata for the structured selectors the on-chain wall decodes (approve /
// transfer / transferFrom / setApprovalForAll / increaseAllowance) + real-world
// non-structured encodings (Uniswap V2/V3, Aave supply, Permit2 permit, multicall)
// as static fixtures, PLUS malicious mutations (dirty high bits, non-canonical bool,
// wrong length, recipient-redirect). The Foundry differential test reads this JSON,
// re-decodes each structured entry through the ACTUAL on-chain decode primitives, and
// asserts agreement with viem; malicious mutations must revert DecodeMismatch on-chain.
//
// Run from ~/leash/backend (has viem):  node ../contracts/script/gen-corpus.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// viem lives in the backend workspace (pnpm, not root-hoisted); resolve it by path
// so this generator runs from any cwd.
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const { encodeFunctionData, parseAbi, decodeFunctionData } = require('viem');

const A = '0x1111111111111111111111111111111111111111'; // stand-in spender/recipient
const B = '0x2222222222222222222222222222222222222222';
const SELF = '0x000000000000000000000000000000000000dEaD'; // the account addr placeholder (test substitutes)

const erc20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);

const univ3 = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256)',
]);
const univ2 = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
]);
const aave = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
]);
const permit2 = parseAbi([
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
]);
const multicallAbi = parseAbi(['function multicall(bytes[] data)']);
const vault = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
]);
const opBridge = parseAbi([
  'function bridgeETHTo(address to, uint32 minGasLimit, bytes extraData) payable',
  'function bridgeERC20To(address localToken, address remoteToken, address to, uint256 amount, uint32 minGasLimit, bytes extraData)',
]);
// SE-9 Arbitrum L2→L1 bridge family — DIVERGENT shapes (GatewayRouter + ArbSys).
const arbBridge = parseAbi([
  'function outboundTransfer(address l1Token, address to, uint256 amount, bytes data)',
  'function withdrawEth(address destination) payable',
]);

const entries = [];
const add = (e) => entries.push(e);

// ---- structured (on-chain decoded) — canonical, must round-trip ----
add({ name: 'approve_canonical', kind: 'approve', mutation: false,
  data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [A, 1000n] }),
  expect: { addr0: A, amount: '1000' } });
add({ name: 'increaseAllowance_canonical', kind: 'approve', mutation: false,
  data: encodeFunctionData({ abi: erc20, functionName: 'increaseAllowance', args: [A, 5n] }),
  expect: { addr0: A, amount: '5' } });
add({ name: 'transfer_canonical', kind: 'transfer', mutation: false,
  data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [B, 250n] }),
  expect: { addr0: B, amount: '250' } });
add({ name: 'transferFrom_canonical', kind: 'transferFrom', mutation: false,
  data: encodeFunctionData({ abi: erc20, functionName: 'transferFrom', args: [SELF, B, 42n] }),
  expect: { addr0: SELF, addr1: B, amount: '42' } });
add({ name: 'setApprovalForAll_false', kind: 'setApprovalForAll', mutation: false,
  data: encodeFunctionData({ abi: erc20, functionName: 'setApprovalForAll', args: [A, false] }),
  expect: { addr0: A, boolVal: 0 } });
// deposit(uint256 assets, address receiver) — ERC-4626 curated-vault, UINT-first layout
// (assets @ offset 4, receiver @ offset 36 — the reverse of transfer, so a wrong-offset
// on-chain decoder would diverge here).
add({ name: 'deposit_canonical', kind: 'deposit', mutation: false,
  data: encodeFunctionData({ abi: vault, functionName: 'deposit', args: [777n, SELF] }),
  expect: { addr0: SELF, amount: '777' } });

// SE-8 bridge decoders — canonical OP-stack encodings (extraData EMPTY = canonical)
add({ name: 'bridgeETHTo_canonical', kind: 'bridgeEth', mutation: false,
  data: encodeFunctionData({ abi: opBridge, functionName: 'bridgeETHTo', args: [SELF, 200000, '0x'] }),
  expect: { addr0: SELF, minGas: '200000' } });
add({ name: 'bridgeERC20To_canonical', kind: 'bridgeErc20', mutation: false,
  data: encodeFunctionData({ abi: opBridge, functionName: 'bridgeERC20To', args: [A, B, SELF, 123456n, 200000, '0x'] }),
  expect: { addr0: A, addr1: B, addr2: SELF, amount: '123456' } });

// SE-9 Arbitrum bridge decoders — canonical DIVERGENT encodings (data EMPTY = canonical).
add({ name: 'arbOutboundTransfer_canonical', kind: 'arbOutbound', mutation: false,
  data: encodeFunctionData({ abi: arbBridge, functionName: 'outboundTransfer', args: [A, SELF, 123456n, '0x'] }),
  expect: { addr0: A, addr1: SELF, amount: '123456' } });
add({ name: 'arbWithdrawEth_canonical', kind: 'arbWithdrawEth', mutation: false,
  data: encodeFunctionData({ abi: arbBridge, functionName: 'withdrawEth', args: [SELF] }),
  expect: { addr0: SELF } });
// Arbitrum mutations: non-empty data (payload smuggle) + dirty recipient bits + redirect.
{
  const payload = encodeFunctionData({ abi: arbBridge, functionName: 'outboundTransfer', args: [A, SELF, 123456n, '0x01'] });
  add({ name: 'arbOutboundTransfer_data_payload', kind: 'arbOutbound', mutation: true, data: payload });
}
{
  const base = encodeFunctionData({ abi: arbBridge, functionName: 'outboundTransfer', args: [A, SELF, 123456n, '0x'] }).slice(2);
  // `to` word at bytes [36,68): high 12 bytes are hex chars [72,96)
  const dirty = '0x' + base.slice(0, 72) + 'ff' + base.slice(74);
  add({ name: 'arbOutboundTransfer_dirty_to_high_bits', kind: 'arbOutbound', mutation: true, data: dirty });
}
{
  const redirect = encodeFunctionData({ abi: arbBridge, functionName: 'outboundTransfer', args: [A, '0x4444444444444444444444444444444444444444', 123456n, '0x'] });
  add({ name: 'arbOutboundTransfer_redirect', kind: 'arbOutbound', mutation: false, forbidden: 'redirect', data: redirect,
    expect: { addr0: A, addr1: '0x4444444444444444444444444444444444444444', amount: '123456' } });
}
{
  // withdrawEth with a trailing extra word → wrong length → DecodeMismatch
  const base = encodeFunctionData({ abi: arbBridge, functionName: 'withdrawEth', args: [SELF] });
  add({ name: 'arbWithdrawEth_trailing_word', kind: 'arbWithdrawEth', mutation: true,
    data: base + '0000000000000000000000000000000000000000000000000000000000000007' });
}

// approve(max) — canonical shape but semantically forbidden on-chain (InfiniteApprovalForbidden)
add({ name: 'approve_max_forbidden', kind: 'approve', mutation: false, forbidden: 'infinite',
  data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [A, (2n ** 256n - 1n)] }),
  expect: { addr0: A, amount: (2n ** 256n - 1n).toString() } });
add({ name: 'setApprovalForAll_true_forbidden', kind: 'setApprovalForAll', mutation: false, forbidden: 'blanket',
  data: encodeFunctionData({ abi: erc20, functionName: 'setApprovalForAll', args: [A, true] }),
  expect: { addr0: A, boolVal: 1 } });

// ---- malicious mutations (must revert DecodeMismatch on-chain) ----
// dirty high bits on the address word of approve
{
  const base = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [A, 1000n] });
  // address word at bytes [4,36): inject a nonzero high byte
  const buf = base.slice(2);
  // word starts at char 8 (4 bytes*2); first 24 hex chars are the high 12 bytes that must be zero
  const dirty = '0x' + buf.slice(0, 8) + 'ff' + buf.slice(10);
  add({ name: 'approve_dirty_addr_high_bits', kind: 'approve', mutation: true, data: dirty });
}
// non-canonical bool for setApprovalForAll (value 2)
{
  const base = encodeFunctionData({ abi: erc20, functionName: 'setApprovalForAll', args: [A, false] }).slice(2);
  // bool word is last 32 bytes; set to 2
  const boolWord = '0000000000000000000000000000000000000000000000000000000000000002';
  const mutated = '0x' + base.slice(0, base.length - 64) + boolWord;
  add({ name: 'setApprovalForAll_noncanonical_bool', kind: 'setApprovalForAll', mutation: true, data: mutated });
}
// wrong length: approve with trailing bytes
{
  const base = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [A, 1000n] });
  add({ name: 'approve_trailing_bytes', kind: 'approve', mutation: true, data: base + 'deadbeef' });
}
// wrong length: transferFrom truncated
{
  const base = encodeFunctionData({ abi: erc20, functionName: 'transferFrom', args: [SELF, B, 42n] });
  add({ name: 'transferFrom_truncated', kind: 'transferFrom', mutation: true, data: base.slice(0, base.length - 64) });
}
// dirty high bits on the RECEIVER word of deposit (word 2, at bytes [36,68))
{
  const base = encodeFunctionData({ abi: vault, functionName: 'deposit', args: [777n, SELF] }).slice(2);
  // receiver word starts at hex char 8 + 64 = 72; its high 12 bytes = first 24 hex chars.
  const dirty = '0x' + base.slice(0, 72) + 'ff' + base.slice(74);
  add({ name: 'deposit_dirty_receiver_high_bits', kind: 'deposit', mutation: true, data: dirty });
}

// bridge mutations: non-empty extraData (payload smuggle) + dirty recipient bits + redirect
{
  const payload = encodeFunctionData({ abi: opBridge, functionName: 'bridgeETHTo', args: [SELF, 200000, '0xdeadbeef'] });
  add({ name: 'bridgeETHTo_extraData_payload', kind: 'bridgeEth', mutation: true, data: payload });
}
{
  const base = encodeFunctionData({ abi: opBridge, functionName: 'bridgeETHTo', args: [SELF, 200000, '0x'] }).slice(2);
  // `to` word at bytes [4,36): high 12 bytes are hex chars [8,32)
  const dirty = '0x' + base.slice(0, 8) + 'ff' + base.slice(10);
  add({ name: 'bridgeETHTo_dirty_to_high_bits', kind: 'bridgeEth', mutation: true, data: dirty });
}
{
  const redirect = encodeFunctionData({ abi: opBridge, functionName: 'bridgeERC20To', args: [A, B, '0x4444444444444444444444444444444444444444', 123456n, 200000, '0x'] });
  add({ name: 'bridgeERC20To_redirect', kind: 'bridgeErc20', mutation: false, forbidden: 'redirect', data: redirect,
    expect: { addr0: A, addr1: B, addr2: '0x4444444444444444444444444444444444444444', amount: '123456' } });
}
{
  const payload = encodeFunctionData({ abi: opBridge, functionName: 'bridgeERC20To', args: [A, B, SELF, 123456n, 200000, '0x01'] });
  add({ name: 'bridgeERC20To_extraData_payload', kind: 'bridgeErc20', mutation: true, data: payload });
}

// ---- real-world non-structured encodings (off-chain decode; on-chain charges msg.value) ----
add({ name: 'uniswapV3_exactInputSingle', kind: 'nonstructured', mutation: false,
  data: encodeFunctionData({ abi: univ3, functionName: 'exactInputSingle', args: [{
    tokenIn: A, tokenOut: B, fee: 3000, recipient: SELF, amountIn: 1000000n, amountOutMinimum: 990000n,
    sqrtPriceLimitX96: 0n }] }) });
add({ name: 'uniswapV2_swapExactTokensForTokens', kind: 'nonstructured', mutation: false,
  data: encodeFunctionData({ abi: univ2, functionName: 'swapExactTokensForTokens', args: [
    1000000n, 990000n, [A, B], SELF, 1999999999n] }) });
add({ name: 'aave_supply', kind: 'nonstructured', mutation: false,
  data: encodeFunctionData({ abi: aave, functionName: 'supply', args: [A, 500000n, SELF, 0] }) });
add({ name: 'permit2_permit', kind: 'nonstructured', mutation: false,
  data: encodeFunctionData({ abi: permit2, functionName: 'permit', args: [SELF,
    { details: { token: A, amount: 1000000n, expiration: 1999999999, nonce: 0 }, spender: B, sigDeadline: 1999999999n },
    '0x' + 'ab'.repeat(65)] }) });
add({ name: 'multicall_wrapper', kind: 'nonstructured', mutation: false,
  data: encodeFunctionData({ abi: multicallAbi, functionName: 'multicall', args: [[
    encodeFunctionData({ abi: erc20, functionName: 'approve', args: [A, 1n] }),
    encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [B, 2n] }),
  ]] }) });

// Self-check: viem re-decodes every canonical structured entry (the oracle is genuinely viem).
for (const e of entries) {
  if (e.mutation || e.kind === 'nonstructured') continue;
  const abi = e.kind === 'deposit'
    ? vault
    : (e.kind === 'bridgeEth' || e.kind === 'bridgeErc20')
      ? opBridge
      : (e.kind === 'arbOutbound' || e.kind === 'arbWithdrawEth')
        ? arbBridge
        : erc20;
  const dec = decodeFunctionData({ abi, data: e.data });
  // sanity: viem decodes without throwing (canonical)
  if (!dec.functionName) throw new Error('viem failed to decode ' + e.name);
}

const out = { generatedBy: 'viem ' + '(gen-corpus.mjs)', count: entries.length, selectors: {
  approve: '0x095ea7b3', increaseAllowance: '0x39509351', transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd', setApprovalForAll: '0xa22cb465', deposit: '0x6e553f65',
  bridgeETHTo: '0xe11013dd', bridgeERC20To: '0x540abf73',
  outboundTransfer: '0x7b3a3c8b', withdrawEth: '0x25e16063' }, entries };
writeFileSync(new URL('../test/corpus/corpus.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('wrote corpus:', entries.length, 'entries (' +
  entries.filter(e => e.mutation).length + ' mutations, ' +
  entries.filter(e => e.kind === 'nonstructured').length + ' non-structured)');
