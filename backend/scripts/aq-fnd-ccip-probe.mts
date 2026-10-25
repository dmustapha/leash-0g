/**
 * AQ-FND — P-CCIP: is Chainlink CCIP a usable 0G rail, LIVE on 0G Galileo (16602)?
 *
 * Lane A step 1 of AQ-FND-RAILS-KICKOFF. D-5 ruled CCIP for every 0G leg. The CCIP
 * directory (REST API) lists 0G Galileo testnet (internalId 0g-testnet-galileo-1,
 * chainId 16602) as supported=true with router 0xD610B8f5…bD57 — but the kickoff law
 * is on-chain-tested, never vibes: this probe READS the router live.
 *
 * Verdicts:
 *   code present at the 0G router + the three Sepolia routers
 *   router.getWrappedNative() answers (proves it is a real CCIP Router)
 *   router.isChainSupported(destSelector) for Base/Eth/Arb Sepolia FROM the 0G router
 *     → proves the outbound LANE exists (directory listing ≠ live lane)
 *
 * If the 0G router has no code or isChainSupported==false for the integrated chains, the
 * testnet story falls to the intent-rail leg and CCIP lands mainnet-gated (surface, don't swap).
 *
 * Run:  cd /Users/MAC/leash/backend && npx tsx scripts/aq-fnd-ccip-probe.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Address } from 'viem';

const OUT = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd';

const CHAINS = {
  og_testnet: { id: 16602, name: '0G Galileo Testnet', rpc: 'https://evmrpc-testnet.0g.ai',
    router: '0xD610B8f58689de7755947C05342A2DFaC30ebD57' as Address, selector: 6892437333620424805n },
  base_sepolia: { id: 84532, name: 'Base Sepolia', rpc: 'https://base-sepolia.drpc.org',
    router: '0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93' as Address, selector: 10344971235874465080n },
  eth_sepolia: { id: 11155111, name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    router: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59' as Address, selector: 16015286601757825753n },
  arb_sepolia: { id: 421614, name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    router: '0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165' as Address, selector: 3478487238524512106n },
  og_mainnet: { id: 16661, name: '0G Mainnet', rpc: 'https://evmrpc.0g.ai',
    router: '0x0aA145a62153190B8f0D3cA00c441e451529f755' as Address, selector: 4426351306075016396n },
} as const;

const ROUTER_ABI = parseAbi([
  'function getWrappedNative() view returns (address)',
  'function isChainSupported(uint64 chainSelector) view returns (bool)',
]);

type Row = { chain: string; check: string; result: string; verdict: 'YES' | 'NO' | 'INFO' | 'FAIL' };
const rows: Row[] = [];
const log = (r: Row) => { rows.push(r); console.log(`[${r.verdict.padEnd(4)}] ${r.chain.padEnd(22)} ${r.check.padEnd(46)} ${r.result}`); };

const client = (k: keyof typeof CHAINS) =>
  createPublicClient({
    chain: { id: CHAINS[k].id, name: CHAINS[k].name, nativeCurrency: { name: 'x', symbol: 'x', decimals: 18 }, rpcUrls: { default: { http: [CHAINS[k].rpc] } } },
    transport: http(CHAINS[k].rpc, { timeout: 20_000 }),
  });

async function main() {
  mkdirSync(OUT, { recursive: true });

  // code presence at every router
  for (const k of Object.keys(CHAINS) as (keyof typeof CHAINS)[]) {
    try {
      const code = await client(k).getCode({ address: CHAINS[k].router });
      const present = !!code && code !== '0x';
      log({ chain: CHAINS[k].name, check: 'CCIP Router code present', result: present ? `code ${((code!.length - 2) / 2)}B @ ${CHAINS[k].router}` : `NO code @ ${CHAINS[k].router}`, verdict: present ? 'YES' : 'NO' });
    } catch (e) {
      log({ chain: CHAINS[k].name, check: 'CCIP Router code present', result: `RPC error: ${(e as Error).message.slice(0, 80)}`, verdict: 'FAIL' });
    }
  }

  // the 0G Galileo router is a REAL CCIP router + the outbound lanes exist
  const og = client('og_testnet');
  try {
    const wnative = await og.readContract({ address: CHAINS.og_testnet.router, abi: ROUTER_ABI, functionName: 'getWrappedNative' });
    log({ chain: '0G Galileo Testnet', check: 'router.getWrappedNative() answers', result: `wrappedNative=${wnative}`, verdict: 'YES' });
  } catch (e) {
    log({ chain: '0G Galileo Testnet', check: 'router.getWrappedNative() answers', result: `read failed: ${(e as Error).message.slice(0, 100)}`, verdict: 'FAIL' });
  }
  for (const dest of ['base_sepolia', 'eth_sepolia', 'arb_sepolia'] as const) {
    try {
      const supported = await og.readContract({ address: CHAINS.og_testnet.router, abi: ROUTER_ABI, functionName: 'isChainSupported', args: [CHAINS[dest].selector] });
      log({ chain: '0G Galileo Testnet', check: `lane → ${CHAINS[dest].name} (sel ${CHAINS[dest].selector})`, result: `isChainSupported=${supported}`, verdict: supported ? 'YES' : 'NO' });
    } catch (e) {
      log({ chain: '0G Galileo Testnet', check: `lane → ${CHAINS[dest].name}`, result: `read failed: ${(e as Error).message.slice(0, 100)}`, verdict: 'FAIL' });
    }
  }
  // reverse: does Base Sepolia's router support the 0G lane back?
  try {
    const back = await client('base_sepolia').readContract({ address: CHAINS.base_sepolia.router, abi: ROUTER_ABI, functionName: 'isChainSupported', args: [CHAINS.og_testnet.selector] });
    log({ chain: 'Base Sepolia', check: `lane → 0G Galileo (sel ${CHAINS.og_testnet.selector})`, result: `isChainSupported=${back}`, verdict: back ? 'YES' : 'NO' });
  } catch (e) {
    log({ chain: 'Base Sepolia', check: 'lane → 0G Galileo', result: `read failed: ${(e as Error).message.slice(0, 100)}`, verdict: 'FAIL' });
  }

  const stamp = new Date().toISOString();
  const selectors = Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, { chainId: v.id, router: v.router, selector: v.selector.toString() }]));
  writeFileSync(`${OUT}/ccip-probe-results.json`, JSON.stringify({ stamp, selectors, rows }, null, 2));
  const md = [
    `# AQ-FND P-CCIP probe results — ${stamp}`, '',
    '| chain | check | result | verdict |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.chain} | ${r.check} | ${r.result.replaceAll('|', '\\|')} | **${r.verdict}** |`),
  ].join('\n');
  writeFileSync(`${OUT}/ccip-probe-results.md`, md);
  console.log(`\nwritten → ${OUT}/ccip-probe-results.{json,md}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
