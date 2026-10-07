// B-hero REHEARSAL (off-camera) — stage demo agent 7451fc0c for the trade beats and
// prove the FULL product chain once before any recording: owner grants (spend budget +
// approve rule + swap rule, each timelocked ~15 min, single pending slot) → API read-model
// record → runtime loop emits governed 'call' (approve, then in-band swap) on RH 46630.
// Owner-a signs headlessly (this agent's owner). Logged in findings as sanctioned
// between-takes staging per Structure §Claude-in-Chrome protocol.
// Run: cd backend && npx tsx scripts/rh2-campaign/bhero-rehearsal.ts
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
const ACCT = getAddress('0xF2c06CCa6B1Cd3d5Ee4E2e61EB5bBc7AD82a5FC8');
const AGENT = '7451fc0c-7750-4a45-96fd-90e24e033e64';
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

async function send(w: typeof opsW, to: Hex, data: Hex, gas = 600_000n): Promise<Hex> {
  const h = await w.sendTransaction({ chain: null, to, data, gas });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`tx ${h} REVERTED`);
  return h;
}

// Poll an owner apply tx until the timelock matures (eth_call preflight, no gas burn).
async function pollApply(fn: 'applyCallRule' | 'applySpendBudget', maxMin = 25): Promise<Hex> {
  const data = encodeFunctionData({ abi: leashAccountV4Abi, functionName: fn, args: [] });
  for (let i = 0; i < maxMin; i++) {
    try {
      await pub.call({ account: ownerA.address, to: ACCT, data });
      return await send(ownW, ACCT, data);
    } catch {
      log(`${fn}: timelock not matured, wait 60s (${i + 1}/${maxMin})`);
      await sleep(60_000);
    }
  }
  throw new Error(`${fn} never matured in ${maxMin} min`);
}

async function main() {
  const { privyLogin, makeApi } = await import('./common.mjs');
  const api = makeApi(await privyLogin(ownerA), API);

  // sanity + gas
  const [ownBal, susd] = await Promise.all([
    pub.getBalance({ address: ownerA.address }),
    pub.readContract({ address: SUSD, abi: balanceFrag, functionName: 'balanceOf', args: [ACCT] }) as Promise<bigint>,
  ]);
  log('owner-a RH gas', ownBal.toString(), '| demo acct sUSD', (susd / E18).toString());
  if (ownBal < 5n * 10n ** 14n) {
    await send(opsW, ownerA.address as Hex, '0x' as Hex, 21_000n).catch(async () => {
      const h = await opsW.sendTransaction({ chain: null, to: ownerA.address, value: 10n ** 15n });
      await pub.waitForTransactionReceipt({ hash: h });
    });
    log('owner-a topped up');
  }
  const det = await api(`/api/agents/${AGENT}`);
  const sess = det.body.agent?.sessionKeyAddr ?? det.body.sessionKeyAddr;
  log('agent', det.status, 'status', det.body.agent?.status ?? det.body.status, 'session', sess);
  if (sess) {
    const sb = await pub.getBalance({ address: sess });
    log('session RH gas', sb.toString());
    if (sb < 10n ** 14n) {
      const h = await opsW.sendTransaction({ chain: null, to: sess, value: 2n * 10n ** 14n });
      await pub.waitForTransactionReceipt({ hash: h });
      log('session key topped up 0.0002');
    }
  }

  // ---- Grant 1: spend budget for sUSD (timelocked) ----
  log('propose spendBudget sUSD 5000');
  await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeSpendBudget', args: [SUSD, 5000n * E18] }));
  await pollApply('applySpendBudget');
  log('spendBudget APPLIED');

  // ---- Grant 2: approve rule (SUSD.approve → spender router) ----
  log('propose callRule approve');
  const t2 = await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [SUSD, APPROVE_SEL, 0, [ROUTER], 2000n * E18, 5000n * E18, ZERO32] }));
  await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({
    action: 'propose', txHash: t2,
    rule: { target: SUSD.toLowerCase(), selector: APPROVE_SEL, recipientMode: 'self', spenderSet: [ROUTER.toLowerCase()], perCallCap: (2000n * E18).toString(), windowCapCall: (5000n * E18).toString() },
  }) }).then((r: any) => log('record approve rule ->', r.status));
  await pollApply('applyCallRule');
  log('approve rule APPLIED');

  // ---- Grant 3: swap rule (router.swap, recipient self) ----
  log('propose callRule swap');
  const t3 = await send(ownW, ACCT, encodeFunctionData({ abi: leashAccountV4Abi, functionName: 'proposeCallRule', args: [ROUTER, SWAP_SEL, 0, [], 500n * E18, 2000n * E18, ZERO32] }));
  await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: JSON.stringify({
    action: 'propose', txHash: t3,
    rule: { target: ROUTER.toLowerCase(), selector: SWAP_SEL, recipientMode: 'self', spenderSet: [], perCallCap: (500n * E18).toString(), windowCapCall: (2000n * E18).toString() },
  }) }).then((r: any) => log('record swap rule ->', r.status));
  await pollApply('applyCallRule');
  log('swap rule APPLIED');

  // ---- healthy feed ----
  await send(opsW, FEED, encodeFunctionData({ abi: setAnswerFrag, functionName: 'setAnswer', args: [10_000_000_000n] }));
  await send(opsW, FEED, encodeFunctionData({ abi: setStaleFrag, functionName: 'setStale', args: [0n] }));
  log('feed healthy: $100 fresh');

  // ---- start + direct the agent ----
  const st = await api(`/api/agents/${AGENT}/start`, { method: 'POST', body: '{}' });
  log('start ->', st.status);
  const d = await api(`/api/agents/${AGENT}/direct`, { method: 'POST', body: JSON.stringify({
    intent: 'You now have swap capability. Approve the router to spend sUSD, then buy sTSLA with 100 sUSD per trade, staying inside your price band.',
  }) });
  const dir = d.body.direction ?? d.body;
  log('direct ->', d.status, 'understanding:', (dir.draft?.understanding ?? '').slice(0, 140));
  if (dir.id) {
    const c = await api(`/api/agents/${AGENT}/direct/${dir.id}/confirm`, { method: 'POST', body: JSON.stringify({ edited: {} }) });
    log('confirm ->', c.status);
  }

  // ---- watch for the governed call (up to 6 min) ----
  const t0 = Date.now();
  let swapTx = '', approveSeen = false;
  while (Date.now() - t0 < 360_000) {
    await sleep(15_000);
    const tr = await api(`/api/agents/${AGENT}/traces?limit=50`);
    const traces = tr.body.traces ?? [];
    for (const t of traces) {
      const s = JSON.stringify(t);
      if (/approve/i.test(s) && t.type === 'action') approveSeen = true;
      if (t.type === 'action' && /swap|call/i.test(s) && /0x[0-9a-f]{64}/.test(s)) {
        const m = s.match(/0x[0-9a-f]{64}/);
        if (m) swapTx = m[0];
      }
    }
    const bal = await pub.readContract({ address: STSLA, abi: balanceFrag, functionName: 'balanceOf', args: [ACCT] }) as bigint;
    log(`watch ${(Date.now() - t0) / 1000 | 0}s: traces=${traces.length} approveSeen=${approveSeen} sTSLA=${bal / E18}`);
    if (bal >= 1n * E18) { log('SWAP LANDED — sTSLA', (bal / E18).toString(), 'tx', swapTx); break; }
  }
  const finalBal = await pub.readContract({ address: STSLA, abi: balanceFrag, functionName: 'balanceOf', args: [ACCT] }) as bigint;
  await api(`/api/agents/${AGENT}/stop`, { method: 'POST', body: '{}' }).then((r: any) => log('stop ->', r.status));

  const verdict = finalBal >= 1n * E18 ? 'PASS' : '**FAIL**';
  appendFileSync(new URL('../../../tasks/e2e-rh-findings.md', import.meta.url),
    `\n### B-hero (rehearsal staging, off-camera) — ${new Date().toISOString()}\n` +
    `| case | result | note |\n|---|---|---|\n` +
    `| BH-R1-grants-staged | PASS | spendBudget 5000 sUSD + approve rule + swap rule applied on 0xF2c0…5FC8 (3× ~15-min timelock, owner-a signed) |\n` +
    `| BH-R2-runtime-swap | ${verdict} | directed agent; sTSLA=${finalBal / E18}; swapTx=${swapTx || 'n/a'}; approveSeen=${approveSeen} |\n`);
  log('DONE. verdict:', verdict, 'sTSLA', (finalBal / E18).toString());
}

main().catch((e) => { console.error('REHEARSAL FATAL:', e.message); process.exit(1); });
