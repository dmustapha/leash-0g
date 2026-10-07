// FR3 ACCEPTANCE (headless, off-camera) — prove the F-8 fix end-to-end on RH 46630:
// a fresh owner-a BAND agent with the NEW trader goal, grants staged through the
// PRODUCT surfaces (API record + owner-signed txs), executes an in-band swap from
// its OWN decide loop within a cycle of start; then PremiumBreach and StaleOracle
// surface as plain-language refusal traces; feed restored after.
// Run: cd backend && npx tsx scripts/rh2-campaign/fr3-acceptance.ts
import { readFileSync, appendFileSync } from 'node:fs';
import {
  createWalletClient, createPublicClient, http, encodeFunctionData, toFunctionSelector,
  getAddress, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { leashAccountV4Abi } from '../../src/chain/abis.js';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) { const i = t.indexOf('='); env[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, ''); }
}

const API = 'https://leash-0g-backend-rh2.onrender.com';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const SUSD = getAddress('0x5F6a3AbC97E421f7B3930fc504D6a0CE4eE41e06');
const STSLA = getAddress('0xB9431b3be9a56a1eeA8E728326332f8B4dD51382');
const ROUTER = getAddress('0x4964991514f731CB3CF252108dFF889d30036fcb');
const FEED = getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE');
const APPROVE_SEL = toFunctionSelector('approve(address,uint256)');
const SWAP_SEL = toFunctionSelector('swap(address,address,uint256,uint256,address,uint256)');
const E18 = 10n ** 18n;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY as Hex);
const ownerA = privateKeyToAccount(readFileSync(new URL('./state/owner-a.key', import.meta.url), 'utf8').trim() as Hex);
const pub = createPublicClient({ transport: http(RPC) });
const opsW = createWalletClient({ account: ops, transport: http(RPC) });
const ownW = createWalletClient({ account: ownerA, transport: http(RPC) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const setStaleFrag = [{ name: 'setStale', type: 'function', inputs: [{ type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const setAnswerFrag = [{ name: 'setAnswer', type: 'function', inputs: [{ type: 'int256' }], outputs: [], stateMutability: 'nonpayable' }] as const;
const balanceFrag = [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as const;
const mintFrag = [{ name: 'mint', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const;

async function send(w: typeof opsW, to: Hex, data: Hex, gas = 600_000n): Promise<Hex> {
  const h = await w.sendTransaction({ chain: null, to, data, gas });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`tx ${h} REVERTED`);
  return h;
}

async function pollApply(acct: Hex, fn: 'applyCallRule' | 'applySpendBudget', maxMin = 25): Promise<Hex> {
  const data = encodeFunctionData({ abi: leashAccountV4Abi, functionName: fn, args: [] });
  for (let i = 0; i < maxMin; i++) {
    try {
      await pub.call({ account: ownerA.address, to: acct, data });
      return await send(ownW, acct, data);
    } catch {
      log(`${fn}: timelock not matured, wait 60s (${i + 1}/${maxMin})`);
      await sleep(60_000);
    }
  }
  throw new Error(`${fn} never matured in ${maxMin} min`);
}

const results: Array<[string, string, string]> = [];
const rec = (c: string, ok: boolean, note: string) => { results.push([c, ok ? 'PASS' : '**FAIL**', note]); log(c, ok ? 'PASS' : 'FAIL', note); };

async function main() {
  const { privyLogin, makeApi } = await import('./common.mjs');
  const api = makeApi(await privyLogin(ownerA), API);

  // owner-a gas
  const ownBal = await pub.getBalance({ address: ownerA.address });
  if (ownBal < 10n ** 15n) {
    const h = await opsW.sendTransaction({ chain: null, to: ownerA.address, value: 2n * 10n ** 15n });
    await pub.waitForTransactionReceipt({ hash: h });
    log('owner-a topped up');
  }

  // ---- FR3-1: create a fresh BAND trader agent via the product API ----
  const { PrivateKey } = await import('eciesjs');
  const k = new PrivateKey();
  const create = await api('/api/agents', { method: 'POST', body: JSON.stringify({
    name: 'FR3 trader (acceptance)',
    chainId: 46630,
    capability: 'oracleBand',
    goal: {
      type: 'trader',
      holdToken: STSLA.toLowerCase(),
      spendToken: SUSD.toLowerCase(),
      targetHoldWei: (3n * E18).toString(), // 3 clips to the target: swap #1 proves in-band; #2/#3 meet the breach/stale walls
      clipWei: (100n * E18).toString(),
    },
    policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 24 * 3600, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 },
    allowlist: [],
    auditPubKey: k.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'fr3-acceptance' })).toString('base64'),
  }) });
  rec('FR3-1-create-trader', create.status === 201, `${create.status} ${create.body.agentId ?? JSON.stringify(create.body).slice(0, 140)}`);
  if (create.status !== 201) throw new Error('create failed');
  const AGENT = create.body.agentId as string;
  const ACCT = getAddress(create.body.accountAddr as string);
  const SESS = getAddress(create.body.sessionKeyAddr as string);
  log('trader agent', AGENT, 'acct', ACCT, 'session', SESS);

  // fund: sUSD (open faucet mint) + session gas top-up if dust was short
  await send(opsW, SUSD, encodeFunctionData({ abi: mintFrag, functionName: 'mint', args: [ACCT, 1000n * E18] }));
  log('1000 sUSD minted to trader account');
  const sb = await pub.getBalance({ address: SESS });
  if (sb < 10n ** 14n) {
    const h = await opsW.sendTransaction({ chain: null, to: SESS, value: 3n * 10n ** 14n });
    await pub.waitForTransactionReceipt({ hash: h });
    log('session key topped up');
  }

  // ---- FR3-2: stage grants through the product record path (owner signs, API records) ----
  log('propose spendBudget sUSD 5000');
  await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [SUSD, 5000n * E18] }));
  await pollApply(ACCT, 'applySpendBudget');
  log('spendBudget APPLIED');

  log('propose callRule approve');
  const t2 = await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [SUSD, APPROVE_SEL, 0, [ROUTER], 2000n * E18, 5000n * E18, ZERO32] }));
  const approveRule = { target: SUSD.toLowerCase(), selector: APPROVE_SEL, recipientMode: 'self', spenderSet: [ROUTER.toLowerCase()], perCallCap: (2000n * E18).toString(), windowCapCall: (5000n * E18).toString() };
  await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({ action: 'propose', txHash: t2, rule: approveRule }) });
  const a2 = await pollApply(ACCT, 'applyCallRule');
  // FR3 (F-8c): the NEW apply record action — proposed→active in the read-model
  const ra = await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({ action: 'apply', txHash: a2, rule: approveRule }) });
  rec('FR3-2a-apply-record', ra.status === 200, `apply record -> ${ra.status}`);

  log('propose callRule swap');
  const t3 = await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [ROUTER, SWAP_SEL, 0, [], 500n * E18, 2000n * E18, ZERO32] }));
  const swapRule = { target: ROUTER.toLowerCase(), selector: SWAP_SEL, recipientMode: 'self', spenderSet: [], perCallCap: (500n * E18).toString(), windowCapCall: (2000n * E18).toString() };
  await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({ action: 'propose', txHash: t3, rule: swapRule }) });
  const a3 = await pollApply(ACCT, 'applyCallRule');
  await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({ action: 'apply', txHash: a3, rule: swapRule }) });
  log('swap rule APPLIED + recorded');

  // healthy feed
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [0n] }));
  log('feed healthy: $100 fresh');

  // ---- FR3-3: start — the trader's OWN loop must approve then swap (NO direction) ----
  const st = await api(`/api/agents/${AGENT}/start`, { method: 'POST', body: '{}' });
  log('start ->', st.status);
  const t0 = Date.now();
  let swapTx = '', approveSeen = false, held = 0n;
  while (Date.now() - t0 < 420_000) {
    await sleep(15_000);
    const tr = await api(`/api/agents/${AGENT}/traces?limit=50`);
    for (const t of tr.body.traces ?? []) {
      const s = JSON.stringify(t);
      if (t.type === 'action' && /approve/i.test(s)) approveSeen = true;
      if (t.type === 'action' && /governed call/i.test(s)) {
        const m = s.match(/0x[0-9a-f]{64}/);
        if (m) swapTx = m[0];
      }
    }
    held = await pub.readContract({ address: STSLA, abi: balanceFrag, functionName: 'balanceOf', args: [ACCT] }) as bigint;
    log(`watch ${(Date.now() - t0) / 1000 | 0}s: approveSeen=${approveSeen} sTSLA=${held / E18}`);
    if (held >= 1n * E18) break;
  }
  rec('FR3-3-own-loop-swap', held >= 1n * E18, `sTSLA=${held / E18}; lastActionTx=${swapTx || 'n/a'}; approveSeen=${approveSeen} (no direction given)`);

  // ---- FR3-4: PremiumBreach — the target (3 sTSLA) is NOT met, so the loop keeps
  // trading; push the feed >5% and the next swap attempt must REVERT PremiumBreach,
  // surfacing as a plain-language refusal trace (P2.5 live stream shows the same).
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [11_000_000_000n] })); // $110 = +10%
  log('feed pushed to $110 (breach)');
  let breachSeen = '';
  const t1 = Date.now();
  while (Date.now() - t1 < 300_000 && !breachSeen) {
    await sleep(15_000);
    const tr = await api(`/api/agents/${AGENT}/traces?limit=30`);
    for (const t of tr.body.traces ?? []) {
      const s = JSON.stringify(t);
      if (/PremiumBreach|price band|band/i.test(s) && (t.type === 'decision' || t.type === 'action')) { breachSeen = s.slice(0, 220); break; }
    }
    log(`breach watch ${(Date.now() - t1) / 1000 | 0}s`);
  }
  rec('FR3-4-premium-breach', !!breachSeen, breachSeen || 'no breach refusal trace within 5 min');

  // ---- FR3-5: StaleOracle ----
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [7200n] }));
  log('feed set stale 7200s');
  let staleSeen = '';
  const staleWatchStart = Date.now();
  while (Date.now() - staleWatchStart < 300_000 && !staleSeen) {
    await sleep(15_000);
    const tr = await api(`/api/agents/${AGENT}/traces?limit=30`);
    for (const t of tr.body.traces ?? []) {
      const s = JSON.stringify(t);
      if (/StaleOracle|stale/i.test(s) && (t.type === 'decision' || t.type === 'action')) { staleSeen = s.slice(0, 220); break; }
    }
    log(`stale watch ${(Date.now() - staleWatchStart) / 1000 | 0}s`);
  }
  rec('FR3-5-stale-oracle', !!staleSeen, staleSeen || 'no stale refusal trace within 5 min');

  // ---- restore + stop ----
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [0n] }));
  log('feed restored: $100 fresh');
  await api(`/api/agents/${AGENT}/stop`, { method: 'POST', body: '{}' }).then((r: { status: number }) => log('stop ->', r.status));

  appendFileSync(new URL('../../../tasks/e2e-rh-findings.md', import.meta.url),
    `\n### FR3 acceptance (headless, trader goal) — ${new Date().toISOString()}\n` +
    `Agent ${AGENT} / ${ACCT} (owner-a, band factory, trader goal sTSLA←sUSD, clip 100, target 1→3).\n` +
    `| case | result | note |\n|---|---|---|\n` +
    results.map(([c, r, n]) => `| ${c} | ${r} | ${n.replace(/\|/g, '\\|')} |`).join('\n') + '\n');
  const fails = results.filter(([, r]) => r !== 'PASS').length;
  log(`DONE — ${results.length - fails}/${results.length} PASS`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error('FR3 ACCEPTANCE FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
