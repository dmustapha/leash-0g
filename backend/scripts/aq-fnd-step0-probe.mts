/**
 * AQ-FND — STEP-0 probe (P-GAS-1 · P-GAS-3 · P-XCHAIN-1).
 *
 * The in-house instrument for the AQ-FND BUILD chat (sibling of q2vis/b1 probes): headless,
 * on-chain-tested — every verdict below is read from a live RPC, never from vendor docs alone.
 *
 *   P-GAS-1   does 0G support EIP-7702 type-4 txs / 4337 paymaster infra?  → gates the gas BOOTSTRAP
 *   P-GAS-3   does 0G have a DEX with a token→native route (swap-to-gas)?  → gates the 0G home-chain default
 *   P-XCHAIN-1 is CCTP live on 0G; which integrated chains carry CCTP v2?  → gates D-5 (CCTP + one rail)
 *
 * The 7702 live test self-delegates the OPS key to a CODELESS address (0x…dEaD) — an EOA whose
 * delegation designator points at empty code is inert (incoming calls no-op, the key keeps full
 * control) — then clears the delegation with a second authorization to address(0). Nothing can
 * move funds. Skipped unless --send is passed.
 *
 * Run:
 *   cd /Users/MAC/leash/backend
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) npx tsx scripts/aq-fnd-step0-probe.mts --send
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd';
const SEND = process.argv.includes('--send');

// ---- chains under test ------------------------------------------------------------------
const CHAINS = {
  og_testnet: { id: 16602, name: '0G Galileo testnet', rpc: 'https://evmrpc-testnet.0g.ai' },
  og_mainnet: { id: 16661, name: '0G Aristotle mainnet', rpc: 'https://evmrpc.0g.ai' },
  base_sepolia: { id: 84532, name: 'Base Sepolia', rpc: 'https://base-sepolia.drpc.org' },
  eth_sepolia: { id: 11155111, name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  arb_sepolia: { id: 421614, name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
} as const;

// ---- canonical addresses (presence is verified on-chain; a wrong address simply reads as
// ---- ABSENT on a chain where it is KNOWN present, which self-invalidates the set) --------
const ADDR = {
  // 4337 infra
  entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address,
  entryPointV08: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address,
  nicksCreate2: '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Address,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address,
  // 0G mainnet DEX (Uniswap V3 fork, 0g.ai Sep-2025 tech update)
  ogSwapRouter: '0x18cCa38E51c4C339A6BD6e174025f08360FEEf30' as Address,
  ogUniV3Factory: '0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70' as Address,
  ogW0G: '0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c' as Address,
  // CCTP v2 (Circle canonical, same address across EVM domains)
  cctpV2TokenMessenger_main: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as Address,
  cctpV2MessageTransmitter_main: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as Address,
  cctpV2TokenMessenger_test: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address,
  cctpV2MessageTransmitter_test: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as Address,
  // inert delegate target for the 7702 live test (no code → delegation is a no-op)
  dead: '0x000000000000000000000000000000000000dEaD' as Address,
};

type Row = { chain: string; check: string; result: string; verdict: 'YES' | 'NO' | 'INFO' | 'FAIL' };
const rows: Row[] = [];
const log = (r: Row) => {
  rows.push(r);
  console.log(`[${r.verdict.padEnd(4)}] ${r.chain.padEnd(22)} ${r.check.padEnd(42)} ${r.result}`);
};

const client = (key: keyof typeof CHAINS) =>
  createPublicClient({
    chain: { id: CHAINS[key].id, name: CHAINS[key].name, nativeCurrency: { name: 'x', symbol: 'x', decimals: 18 }, rpcUrls: { default: { http: [CHAINS[key].rpc] } } },
    transport: http(CHAINS[key].rpc, { timeout: 20_000 }),
  });

async function hasCode(ck: keyof typeof CHAINS, addr: Address, label: string): Promise<boolean> {
  try {
    const code = await client(ck).getCode({ address: addr });
    const present = !!code && code !== '0x';
    log({ chain: CHAINS[ck].name, check: label, result: present ? `code ${((code!.length - 2) / 2)}B @ ${addr}` : `NO code @ ${addr}`, verdict: present ? 'YES' : 'NO' });
    return present;
  } catch (e) {
    log({ chain: CHAINS[ck].name, check: label, result: `RPC error: ${(e as Error).message.slice(0, 80)}`, verdict: 'FAIL' });
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // sanity: RPC chainIds match what we claim to test
  for (const ck of Object.keys(CHAINS) as (keyof typeof CHAINS)[]) {
    try {
      const got = await client(ck).getChainId();
      log({ chain: CHAINS[ck].name, check: 'chainId matches', result: `expected ${CHAINS[ck].id}, got ${got}`, verdict: got === CHAINS[ck].id ? 'YES' : 'FAIL' });
    } catch (e) {
      log({ chain: CHAINS[ck].name, check: 'chainId matches', result: `RPC unreachable: ${(e as Error).message.slice(0, 80)}`, verdict: 'FAIL' });
    }
  }

  // ---------------- P-GAS-1: 4337 infra presence + EIP-7702 live test on 0G ----------------
  console.log('\n— P-GAS-1 (0G gas bootstrap: 4337 infra + EIP-7702) —');
  for (const ck of ['og_testnet', 'og_mainnet'] as const) {
    await hasCode(ck, ADDR.entryPointV07, 'EntryPoint v0.7 (4337)');
    await hasCode(ck, ADDR.entryPointV08, 'EntryPoint v0.8 (4337, native 7702)');
    await hasCode(ck, ADDR.nicksCreate2, "Nick's-method CREATE2 factory");
    await hasCode(ck, ADDR.multicall3, 'Multicall3');
  }

  if (SEND && process.env.OPS) {
    const account = privateKeyToAccount(process.env.OPS as Hex);
    const ck = 'og_testnet' as const;
    const chain = { id: CHAINS[ck].id, name: CHAINS[ck].name, nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 }, rpcUrls: { default: { http: [CHAINS[ck].rpc] } } };
    const wallet = createWalletClient({ account, chain, transport: http(CHAINS[ck].rpc, { timeout: 30_000 }) });
    const pub = client(ck);
    try {
      // self-executed type-4: authorization nonce must be account nonce + 1 (executor self)
      const auth = await wallet.signAuthorization({ account, contractAddress: ADDR.dead, executor: 'self' });
      const hash = await wallet.sendTransaction({ authorizationList: [auth], to: account.address, value: 0n, type: 'eip7702' });
      const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const code = await pub.getCode({ address: account.address });
      const designator = code?.toLowerCase() === ('0xef0100' + ADDR.dead.slice(2)).toLowerCase();
      log({ chain: CHAINS[ck].name, check: 'EIP-7702 type-4 tx accepted + designator set', result: `tx ${hash} status=${rcpt.status} code=${code}`, verdict: rcpt.status === 'success' && designator ? 'YES' : 'FAIL' });
      // clear the delegation (authorization to address(0) resets per EIP-7702)
      const clear = await wallet.signAuthorization({ account, contractAddress: '0x0000000000000000000000000000000000000000', executor: 'self' });
      const hash2 = await wallet.sendTransaction({ authorizationList: [clear], to: account.address, value: 0n, type: 'eip7702' });
      const rcpt2 = await pub.waitForTransactionReceipt({ hash: hash2, timeout: 60_000 });
      const code2 = await pub.getCode({ address: account.address });
      log({ chain: CHAINS[ck].name, check: 'EIP-7702 delegation cleared (revoke-to-zero)', result: `tx ${hash2} status=${rcpt2.status} code=${code2 ?? '0x'}`, verdict: rcpt2.status === 'success' && (!code2 || code2 === '0x') ? 'YES' : 'FAIL' });
    } catch (e) {
      const msg = (e as Error).message;
      const unsupported = /type|not supported|invalid|unknown tx|rlp/i.test(msg);
      log({ chain: CHAINS[ck].name, check: 'EIP-7702 type-4 tx accepted', result: `${unsupported ? 'REJECTED (no Prague rules?)' : 'error'}: ${msg.slice(0, 160)}`, verdict: 'NO' });
    }
  } else {
    log({ chain: '0G Galileo testnet', check: 'EIP-7702 live type-4 test', result: 'SKIPPED (pass --send with OPS env to run)', verdict: 'INFO' });
  }

  // ---------------- P-GAS-3: DEX with token→native route on 0G ----------------
  console.log('\n— P-GAS-3 (0G DEX token→native route for swap-to-gas) —');
  for (const ck of ['og_mainnet', 'og_testnet'] as const) {
    const router = await hasCode(ck, ADDR.ogSwapRouter, 'SwapRouter (UniV3 fork)');
    await hasCode(ck, ADDR.ogUniV3Factory, 'UniswapV3Factory');
    const w0g = await hasCode(ck, ADDR.ogW0G, 'W0G (wrapped native)');
    if (router && w0g) {
      try {
        // SwapRouter.WETH9() — proves the router's unwrap leg points at the wrapped native
        const weth9 = await client(ck).readContract({
          address: ADDR.ogSwapRouter,
          abi: [{ name: 'WETH9', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
          functionName: 'WETH9',
        });
        const match = (weth9 as string).toLowerCase() === ADDR.ogW0G.toLowerCase();
        log({ chain: CHAINS[ck].name, check: 'router.WETH9() == W0G (token→native leg)', result: `WETH9()=${weth9}`, verdict: match ? 'YES' : 'INFO' });
      } catch (e) {
        log({ chain: CHAINS[ck].name, check: 'router.WETH9()', result: `read failed: ${(e as Error).message.slice(0, 80)}`, verdict: 'FAIL' });
      }
    }
  }

  // ---------------- P-XCHAIN-1: CCTP on 0G + CCTP v2 on integrated chains ----------------
  console.log('\n— P-XCHAIN-1 (CCTP on 0G? CCTP v2 on the integrated chains?) —');
  await hasCode('og_mainnet', ADDR.cctpV2TokenMessenger_main, 'CCTP v2 TokenMessenger (mainnet addr)');
  await hasCode('og_mainnet', ADDR.cctpV2MessageTransmitter_main, 'CCTP v2 MessageTransmitter (mainnet addr)');
  await hasCode('og_testnet', ADDR.cctpV2TokenMessenger_test, 'CCTP v2 TokenMessenger (testnet addr)');
  await hasCode('og_testnet', ADDR.cctpV2MessageTransmitter_test, 'CCTP v2 MessageTransmitter (testnet addr)');
  for (const ck of ['base_sepolia', 'eth_sepolia', 'arb_sepolia'] as const) {
    await hasCode(ck, ADDR.cctpV2TokenMessenger_test, 'CCTP v2 TokenMessenger (testnet addr)');
    await hasCode(ck, ADDR.multicall3, 'Multicall3');
  }

  // ---------------- write evidence ----------------
  const stamp = new Date().toISOString();
  writeFileSync(`${OUT}/step0-probe-results.json`, JSON.stringify({ stamp, send: SEND, rows }, null, 2));
  const md = [
    `# AQ-FND STEP-0 probe results — ${stamp}`,
    '',
    '| chain | check | result | verdict |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.chain} | ${r.check} | ${r.result.replaceAll('|', '\\|')} | **${r.verdict}** |`),
  ].join('\n');
  writeFileSync(`${OUT}/step0-probe-results.md`, md);
  console.log(`\nwritten → ${OUT}/step0-probe-results.{json,md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
