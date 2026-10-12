// P1 TREASURY QUALITY — Q4 robustness edges.
// C = UNDERFUNDED: below target but the account can't cover the top-up. A GOOD agent
//     reasons about accountBalanceWei and stands down (or sends what it can) rather than
//     blindly proposing a doomed send every cycle. (observation carries accountBalanceWei.)
// D = EXACTLY-AT-TARGET: beneficiary balance == target. Prompt says "meets the target →
//     stand down". Boundary correctness (meets includes ==).
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);
const CYCLES = 5, CYCLE_MS = 35_000;

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}

async function main() {
  console.log(`\n== P1 TREASURY QUALITY — Q4 edges ==`);
  await warm();
  const owner = campaignOwner('tearapart-p1');
  const api = makeApi(await privyLogin(owner));
  const traces = async (id) => (await api(`/api/agents/${id}/traces?limit=600`)).body?.records ?? [];
  const mkAudit = () => { const k = new PrivateKey(); return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from('{}').toString('base64') }; };
  const mkBody = (name, ben, target, topUp) => ({
    name, goal: { beneficiary: ben, targetBalanceWei: target.toString(), topUpWei: topUp.toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
    allowlist: [ben], ...mkAudit(),
  });

  const benC = privateKeyToAccount(generatePrivateKey()); // underfunded account scenario
  const C = await api('/api/agents', { method: 'POST', body: mkBody(`p1q-C-underfunded-${Date.now()}`, benC.address, parseEther('0.002'), parseEther('0.002')) });
  const benD = privateKeyToAccount(generatePrivateKey()); // exactly-at-target scenario
  const D = await api('/api/agents', { method: 'POST', body: mkBody(`p1q-D-atboundary-${Date.now()}`, benD.address, parseEther('0.002'), parseEther('0.002')) });
  const ag = {
    C: { id: C.body?.agentId, acct: C.body?.accountAddr, ben: benC.address, want: 'account UNDERFUNDED (0.001 < 0.002 needed) — reason about low funds / graceful, not doomed retries' },
    D: { id: D.body?.agentId, acct: D.body?.accountAddr, ben: benD.address, want: 'beneficiary EXACTLY at target (0.002==0.002) — STAND DOWN (meets)' },
  };
  if (!ag.C.id || !ag.D.id) { console.log('create failed', JSON.stringify(C.body).slice(0,200), JSON.stringify(D.body).slice(0,200)); return; }

  // C: fund account only 0.001 (below the 0.002 top-up it will want). beneficiary stays 0 (below target).
  await waitReceipt(await opsWallet.sendTransaction({ to: ag.C.acct, value: parseEther('0.001') }));
  // D: fund account 0.01; pre-fund beneficiary to EXACTLY target 0.002.
  await waitReceipt(await opsWallet.sendTransaction({ to: ag.D.acct, value: parseEther('0.01') }));
  await waitReceipt(await opsWallet.sendTransaction({ to: ag.D.ben, value: parseEther('0.002') }));
  console.log(`C.acct funded 0.001 (underfunded), C.ben=${formatEther(await pub.getBalance({ address: ag.C.ben }))}`);
  console.log(`D.ben pre-funded to ${formatEther(await pub.getBalance({ address: ag.D.ben }))} (== target 0.002)\n`);

  await api(`/api/agents/${ag.C.id}/start`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${ag.D.id}/start`, { method: 'POST', body: '{}' });
  for (let c = 1; c <= CYCLES; c++) {
    await sleep(CYCLE_MS);
    const [bc, bd] = [await pub.getBalance({ address: ag.C.ben }), await pub.getBalance({ address: ag.D.ben })];
    const [tc, td] = [await traces(ag.C.id), await traces(ag.D.id)];
    console.log(`cycle ${c}: C.ben=${formatEther(bc)} acts=${tc.filter(r=>r.kind==='action'&&r.detail?.txHash).length} | D.ben=${formatEther(bd)} acts=${td.filter(r=>r.kind==='action'&&r.detail?.txHash).length}`);
  }
  await api(`/api/agents/${ag.C.id}/stop`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${ag.D.id}/stop`, { method: 'POST', body: '{}' });

  for (const key of ['C', 'D']) {
    const a = ag[key]; const tr = await traces(a.id);
    console.log(`\n===== AGENT ${key} (${a.want}) =====`);
    for (const r of tr.filter((r) => /reason|inference|decision|action|stand/i.test(r.kind) || r.detail?.reason || r.detail?.text)) {
      const d = r.detail ?? {}; const txt = d.text ?? d.reason ?? d.decision ?? JSON.stringify(d);
      console.log(`[seq ${r.seq ?? '?'} · ${r.kind}${d.txHash ? ' · tx' : ''}] ${String(txt).replace(/\s+/g,' ').slice(0,500)}`);
    }
    const acts = tr.filter((r) => r.kind === 'action' && r.detail?.txHash);
    console.log(`  >>> ${key}: ben final=${formatEther(await pub.getBalance({ address: a.ben }))}; acts=${acts.length}; EXPECTED: ${a.want}`);
    await api(`/api/agents/${a.id}/revoke`, { method: 'POST' }).catch(() => {});
  }
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
