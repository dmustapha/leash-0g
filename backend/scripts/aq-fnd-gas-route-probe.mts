/**
 * AQ-FND M-3 cross-chain gas routing — INCREMENT 0 PROBE (read-only; no txs, no keys).
 * Answers the unknowns that gate which routes the planner can actually execute on testnet:
 *   1. DEX: is there a Uniswap V3 router + a pool with LIQUIDITY for a native-wrapped/stable pair
 *      on Base / Ethereum / Arbitrum Sepolia? (0G Galileo has none — P-GAS-3.)
 *   2. CCIP: which lanes exist both ways between 0G and Eth/Arb/Base, and what tokens does the
 *      0G on-ramp carry per destination?
 *   3. Singletons: are the V6 helper singletons + delegate present at the SAME address on each chain
 *      (a precondition for the same-address account on Eth/Arb)?
 *   4. Band: does the v6 account expose requireBandForSwap (could block a gas swap with no feed)?
 * Candidate addresses are from public Uniswap/Circle testnet deployments — each is verified by code
 * presence below; a miss is RECORDED as a miss, never assumed.
 *
 *   cd backend && npx tsx scripts/aq-fnd-gas-route-probe.mts
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Address } from 'viem';

type Row = { check: string; chain: string; result: string; verdict: 'YES' | 'NO' | 'UNKNOWN' };
const rows: Row[] = [];
const rec = (chain: string, check: string, result: string, verdict: Row['verdict']) => {
  rows.push({ chain, check, result, verdict });
  console.log(`[${verdict.padEnd(7)}] ${chain} — ${check}: ${result}`);
};

const CHAINS = {
  og: { name: '0G Galileo', id: 16602, rpc: 'https://evmrpc-testnet.0g.ai', ccip: '0xD610B8f58689de7755947C05342A2DFaC30ebD57' as Address, sel: 6892437333620424805n },
  base: { name: 'Base Sepolia', id: 84532, rpc: 'https://sepolia.base.org', ccip: '0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93' as Address, sel: 10344971235874465080n,
    router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4' as Address, weth: '0x4200000000000000000000000000000000000006' as Address, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address },
  eth: { name: 'Ethereum Sepolia', id: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', ccip: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59' as Address, sel: 16015286601757825753n,
    router: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E' as Address, weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as Address, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address },
  arb: { name: 'Arbitrum Sepolia', id: 421614, rpc: 'https://sepolia-rollup.arbitrum.io/rpc', ccip: '0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165' as Address, sel: 3478487238524512106n,
    router: '0x101F443B4d1b059569D643917553c771E1b9663E' as Address, weth: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73' as Address, usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as Address },
} as const;
const clients = Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [k, createPublicClient({ transport: http(c.rpc, { timeout: 25_000 }) })])) as Record<keyof typeof CHAINS, ReturnType<typeof createPublicClient>>;
const safe = async <T,>(f: () => Promise<T>): Promise<T | { err: string }> => { try { return await f(); } catch (e) { return { err: (e as Error).message.split('\n')[0]!.slice(0, 90) }; } };
const isErr = (v: unknown): v is { err: string } => typeof v === 'object' && v !== null && 'err' in v;
const hasCode = async (k: keyof typeof CHAINS, a: Address) => { const c = await safe(() => clients[k].getCode({ address: a })); return !isErr(c) && !!c && c !== '0x'; };

const ROUTER_ABI = parseAbi(['function WETH9() view returns (address)', 'function factory() view returns (address)']);
const FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const POOL_ABI = parseAbi(['function liquidity() view returns (uint128)']);
const CCIP_ABI = parseAbi(['function isChainSupported(uint64) view returns (bool)', 'function getOnRamp(uint64) view returns (address)']);
const ONRAMP_ABI = parseAbi(['function getSupportedTokens(uint64) view returns (address[])']);

// 1. DEX probe (Base / Eth / Arb)
for (const k of ['base', 'eth', 'arb'] as const) {
  const c = CHAINS[k];
  if (!(await hasCode(k, c.router))) { rec(c.name, 'Uniswap V3 SwapRouter02 code', `no code @ ${c.router}`, 'NO'); continue; }
  rec(c.name, 'Uniswap V3 SwapRouter02 code', `present @ ${c.router}`, 'YES');
  const factory = await safe(() => clients[k].readContract({ address: c.router, abi: ROUTER_ABI, functionName: 'factory' }));
  if (isErr(factory)) { rec(c.name, 'router.factory()', factory.err, 'UNKNOWN'); continue; }
  let best = 0n; let bestFee = 0;
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await safe(() => clients[k].readContract({ address: factory as Address, abi: FACTORY_ABI, functionName: 'getPool', args: [c.weth, c.usdc, fee] }));
    if (isErr(pool) || /^0x0{40}$/.test(String(pool))) continue;
    const liq = await safe(() => clients[k].readContract({ address: pool as Address, abi: POOL_ABI, functionName: 'liquidity' }));
    if (!isErr(liq) && (liq as bigint) > best) { best = liq as bigint; bestFee = fee; }
  }
  rec(c.name, 'WETH/USDC pool liquidity (fees 100/500/3000/10000)', best > 0n ? `fee ${bestFee} liquidity=${best}` : 'no pool with liquidity', best > 0n ? 'YES' : 'NO');
}

// 2. CCIP lanes + on-ramp token support
const others = ['base', 'eth', 'arb'] as const;
for (const k of others) {
  const fwd = await safe(() => clients.og.readContract({ address: CHAINS.og.ccip, abi: CCIP_ABI, functionName: 'isChainSupported', args: [CHAINS[k].sel] }));
  rec('0G Galileo', `CCIP lane 0G → ${CHAINS[k].name}`, isErr(fwd) ? fwd.err : String(fwd), isErr(fwd) ? 'UNKNOWN' : fwd ? 'YES' : 'NO');
  const rev = await safe(() => clients[k].readContract({ address: CHAINS[k].ccip, abi: CCIP_ABI, functionName: 'isChainSupported', args: [CHAINS.og.sel] }));
  rec(CHAINS[k].name, 'CCIP lane → 0G', isErr(rev) ? rev.err : String(rev), isErr(rev) ? 'UNKNOWN' : rev ? 'YES' : 'NO');
  if (fwd === true) {
    const onRamp = await safe(() => clients.og.readContract({ address: CHAINS.og.ccip, abi: CCIP_ABI, functionName: 'getOnRamp', args: [CHAINS[k].sel] }));
    if (isErr(onRamp)) { rec('0G Galileo', `getOnRamp(${CHAINS[k].name})`, onRamp.err, 'UNKNOWN'); continue; }
    const toks = await safe(() => clients.og.readContract({ address: onRamp as Address, abi: ONRAMP_ABI, functionName: 'getSupportedTokens', args: [CHAINS[k].sel] }));
    rec('0G Galileo', `on-ramp supported tokens → ${CHAINS[k].name}`, isErr(toks) ? `${toks.err} (onRamp ${onRamp})` : `${(toks as Address[]).length} token(s): ${(toks as Address[]).join(', ') || '(none)'}`, isErr(toks) ? 'UNKNOWN' : (toks as Address[]).length > 0 ? 'YES' : 'NO');
  }
}

// 3. V6 singletons + delegate: same address/code on each chain?
const SINGLETONS: Record<string, Address> = {
  policyHelper: '0x992000cBa746Ae2213cf5dE085CB7fAa239570b5', decodeHelper: '0x512A06eDdE20734f1F9521711bb48246d1f8D173',
  signingHelper: '0x46130314ad969Ac2153Bde1E73c6A36Bb65EB1AB', envelopeModule: '0x973b013234A896545fa96CF37d920bCd44e7189e',
  gasRepayDelegate: '0xBcfA2994636D73Ea21625f83422a08B45e8c88C6', factory: '0x5100f7a9661F56842342C21aAAc15169A7fD3c52',
};
for (const k of ['og', 'base', 'eth', 'arb'] as const) {
  const present: string[] = []; const missing: string[] = [];
  for (const [n, a] of Object.entries(SINGLETONS)) (await hasCode(k, a) ? present : missing).push(n);
  rec(CHAINS[k].name, 'LEASH v6 singletons at the 0G addresses', `present: [${present.join(', ')}] missing: [${missing.join(', ')}]`, missing.length === 0 ? 'YES' : 'NO');
}

// 4. Band requirement exposure on the live v6 account
const band = await safe(() => clients.og.readContract({ address: '0xe55296662581971d8cd7e26fc214b4a68d2c83ca', abi: parseAbi(['function requireBandForSwap() view returns (bool)']), functionName: 'requireBandForSwap' }));
rec('0G Galileo', 'v6 account requireBandForSwap()', isErr(band) ? `not exposed / reverts: ${band.err}` : String(band), isErr(band) ? 'UNKNOWN' : 'YES');

const out = '/Users/MAC/0g-fleet/docs/evidence/aq-fnd/gas-route-probe-results.json';
writeFileSync(out, JSON.stringify({ stamp: new Date().toISOString(), rows }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nwrote ${out} (${rows.length} rows)`);
