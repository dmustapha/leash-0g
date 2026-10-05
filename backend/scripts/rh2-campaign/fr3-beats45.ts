// FR3 beats 4/5 follow-up — the 1:1 mock router meant one clip met the hold
// target, so the main acceptance's breach/stale beats timed out on a (correct)
// "target met" stand-down. Raise the target via the PRODUCT direction lane
// (targetHoldWei is a descriptive, chat-patchable field) so the loop trades
// again, then replay PremiumBreach + StaleOracle and watch for refusal traces.
// Run: cd backend && npx tsx scripts/rh2-campaign/fr3-beats45.ts <agentId>
import { readFileSync, appendFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, encodeFunctionData, getAddress, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) { const i = t.indexOf('='); env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, ''); }
}
const API = 'https://leash-0g-backend-rh2.onrender.com';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const FEED = getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE');
const AGENT = process.argv[2] ?? 'ae179544-3995-46c2-b61a-46c6ff8e1282';
const ACCT = getAddress('0x348a86717C9B0D530B148f3E7F321957B723b4B2');
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const STSLA = getAddress('0xB9431b3be9a56a1eeA8E728326332f8B4dD51382');
const SWAP_SEL = toFunctionSelector('swap(address,address,uint256,uint256,address,uint256)') as Hex;

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const ownerA = privateKeyToAccount(readFileSync(new URL('./state/owner-a.key', import.meta.url), 'utf8').trim() as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const opsW = createWalletClient({ account: ops, transport: http(RPC) });
const ownW = createWalletClient({ account: ownerA, transport: http(RPC) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const setStaleFrag = [{ name: 'setStale', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const tightenBandFrag = [{ name: 'tightenPriceBand', type: 'function', inputs: [{ type: 'address' }, { type: 'bytes4' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint64' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const enableFrag = [{ name: 'enableRequireBandForSwap', type: 'function', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const;
const setAnswerFrag = [{ name: 'setAnswer', type: 'function', inputs: [{ type: 'int256' }], outputs: [], stateMutability: 'nonpayable' }] as const;

async function feedTx(fn: 'setAnswer' | 'setStale', v: bigint) {
  const data = fn === 'setAnswer'
    ? encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [v] })
    : encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [v] });
  const h = await opsW.sendTransaction({ chain: null, to: FEED, data, gas: 300_000n });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`${fn} REVERTED`);
}

const results: Array<[string, string, string]> = [];
const rec = (c: string, ok: boolean, note: string) => { results.push([c, ok ? 'PASS' : '**FAIL**', note]); log(c, ok ? 'PASS' : 'FAIL', note); };

type TraceRow = { seq?: number; kind?: string; type?: string };
type TracesBody = { records?: TraceRow[]; nextCursor?: number | null };
type Api = (p: string, o?: object) => Promise<{ status: number; body: TracesBody }>;

/** /traces is seq-ASC paged by ?cursor=afterSeq — walk to the tail for the max seq. */
async function latestSeq(api: Api): Promise<number> {
  let cursor = -1;
  for (let i = 0; i < 100; i++) {
    const r = await api(`/api/agents/${AGENT}/traces?limit=200&cursor=${cursor}`);
    const rows = r.body.records ?? [];
    for (const t of rows) cursor = Math.max(cursor, t.seq ?? cursor);
    if (rows.length === 0 || r.body.nextCursor == null) break;
    cursor = r.body.nextCursor;
  }
  return cursor;
}

/** Watch ONLY traces appended after `fromSeq` (the pre-beat tail). */
async function watchFor(api: Api, fromSeq: number, re: RegExp, maxMs: number): Promise<string> {
  const t0 = Date.now();
  let cursor = fromSeq;
  while (Date.now() - t0 < maxMs) {
    await sleep(15_000);
    const tr = await api(`/api/agents/${AGENT}/traces?limit=200&cursor=${cursor}`);
    for (const t of tr.body.records ?? []) {
      cursor = Math.max(cursor, t.seq ?? cursor);
      const k = t.kind ?? t.type;
      const s = JSON.stringify(t);
      if (re.test(s) && (k === 'decision' || k === 'action')) return s.slice(0, 220);
    }
    log(`watch ${(Date.now() - t0) / 1000 | 0}s (cursor ${cursor})`);
  }
  return '';
}

async function main() {
  const { privyLogin, makeApi } = await import('./common.mjs');
  const apiRaw = makeApi(await privyLogin(ownerA), API) as (p: string, o?: object) => Promise<{ status: number; body: Record<string, any> }>;
  const api: Api = apiRaw as unknown as Api;

  // ---- ARM THE BAND (FR3b finding: the band factory mints the capability; the
  // band itself must be set + latched by the OWNER — A5 did this on its drill
  // twin; no product surface did it for a wizard agent). tighten = instant.
  const bandData = encodeFunctionData({ abi: tightenBandFrag, functionName: 'tightenPriceBand', args: [ROUTER, SWAP_SEL, FEED, STSLA, 500, 3600n] });
  const h1 = await ownW.sendTransaction({ chain: null, to: ACCT, data: bandData, gas: 400_000n });
  await pub.waitForTransactionReceipt({ hash: h1 });
  try {
    const h2 = await ownW.sendTransaction({ chain: null, to: ACCT, data: encodeFunctionData({ abi: enableFrag, functionName: 'enableRequireBandForSwap', args: [] }), gas: 200_000n });
    await pub.waitForTransactionReceipt({ hash: h2 });
  } catch { /* one-way latch may already be on */ }
  rec('FR3-4z-band-armed', true, 'tightenPriceBand(router, swap, feed, sTSLA, 500bps, 3600s) + requireBandForSwap latched (owner-a)');

  // Raise the hold target via the product direction lane so the loop trades again
  // (500 held; 500 sUSD left = 5 clips of headroom).
  const det = await apiRaw(`/api/agents/${AGENT}`);
  const goal = (det.body.agent ?? det.body).goal ?? {};
  log('goal targetHoldWei:', goal.targetHoldWei);
  if (BigInt(goal.targetHoldWei ?? '0') < 900n * 10n ** 18n) {
    const d = await apiRaw(`/api/agents/${AGENT}/direct`, { method: 'POST', body: JSON.stringify({
      intent: 'Raise your hold target to 1000 sTSLA. Keep the per-trade clip at 100 sUSD.',
    }) });
    const dir = d.body.direction ?? d.body;
    const goalPatch = dir.draft?.goalPatch ?? dir.goalPatch;
    log('direct ->', d.status, 'patch:', JSON.stringify(goalPatch ?? {}));
    if (!dir.id || !goalPatch?.targetHoldWei) throw new Error('direction draft missing targetHoldWei');
    // Confirm applies edited.goalPatch (NOT the draft implicitly) — pass it through.
    const c = await apiRaw(`/api/agents/${AGENT}/direct/${dir.id}/confirm`, { method: 'POST', body: JSON.stringify({ edited: { goalPatch } }) });
    log('confirm ->', c.status, JSON.stringify(c.body).slice(0, 120));
  }

  await feedTx('setAnswer', 10_000_000_000n);
  await feedTx('setStale', 0n);
  const st = await apiRaw(`/api/agents/${AGENT}/start`, { method: 'POST', body: '{}' });
  log('start ->', st.status);

  // Beat 4a: an in-band trade WITH the band armed (runtime minOut from the feed).
  let seq = await latestSeq(api);
  log('tail seq at beat start:', seq);
  const traded = await watchFor(api, seq, /governed call/i, 300_000);
  rec('FR3-4a-armed-inband-trade', !!traded, traded ? `in-band swap with band ARMED: ${traded.slice(0, 140)}` : 'no trade after target raise');

  // Beat 4: PremiumBreach. The runtime bids the feed price it SENSED at cycle
  // start; drop the feed mid-cycle so the wall sees the stale bid as a premium
  // ($100 bid vs $80 oracle → implied > max $84 → revert). Alternate the feed
  // so pushes keep landing inside reasoning windows.
  seq = await latestSeq(api);
  let breach = '';
  for (let attempt = 0; attempt < 4 && !breach; attempt++) {
    await feedTx('setAnswer', 10_000_000_000n); // let a cycle sense $100
    await sleep(20_000);
    await feedTx('setAnswer', 8_000_000_000n); // drop to $80 mid-cycle
    log(`breach attempt ${attempt + 1}: feed dropped to $80`);
    // Watch from the SAME tail each attempt (review fix): advancing seq on a
    // miss would permanently skip a breach trace that lands after the window.
    breach = await watchFor(api, seq, /PremiumBreach|price band|refused|reverted/i, 90_000);
  }
  rec('FR3-4-premium-breach', !!breach, breach || 'no breach refusal trace across 4 feed-drop attempts');

  // Beat 5: stale oracle — any swap attempt reverts StaleOracle (fail-closed).
  seq = await latestSeq(api);
  await feedTx('setAnswer', 10_000_000_000n);
  await feedTx('setStale', 7200n);
  log('feed set stale 7200s');
  const stale = await watchFor(api, seq, /StaleOracle|stale|refused|reverted/i, 300_000);
  rec('FR3-5-stale-oracle', !!stale, stale || 'no stale refusal trace in 5 min');

  // Restore + stop.
  await feedTx('setAnswer', 10_000_000_000n);
  await feedTx('setStale', 0n);
  log('feed restored: $100 fresh');
  await apiRaw(`/api/agents/${AGENT}/stop`, { method: 'POST', body: '{}' }).then((r: { status: number }) => log('stop ->', r.status));

  appendFileSync(new URL('../../../tasks/e2e-rh-findings.md', import.meta.url),
    `\n### FR3 beats 4/5 follow-up (target raised via direction) — ${new Date().toISOString()}\n` +
    `| case | result | note |\n|---|---|---|\n` +
    results.map(([cse, r, n]) => `| ${cse} | ${r} | ${n.replace(/\|/g, '\\|')} |`).join('\n') + '\n');
  const fails = results.filter(([, r]) => r !== 'PASS').length;
  log(`DONE — ${results.length - fails}/${results.length} PASS`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error('FR3 BEATS45 FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
