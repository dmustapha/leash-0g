// P1 TREASURY QUALITY drill (Behavioral-Quality lens, extensive).
// Question: is the agent actually DOING WHAT WE WANT — not "do the walls hold."
// Measures, across many live cycles, on BOTH decision branches:
//   Q1 decision correctness: ACT (exact topUp to the beneficiary ONLY) when below target;
//                            STAND DOWN when at/above target.
//   Q2 reasoning soundness:  does the 0G-Compute reasoning read the observation correctly,
//                            apply the rules, and PARSE into a usable decision — or drop to a
//                            stand-down-by-parse-failure (the code-admitted F-4 weakness)?
// Two agents run concurrently: A = below-target (should act then stand down),
//                              B = above-target (should stand down every cycle).
// Dumps every reasoning/decision trace + on-chain effect; the ANCHOR judges against the bar.
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);
const CYCLES = 7;        // ~7 runtime cycles (~4 min) → enough samples for the parse-rate pattern
const CYCLE_MS = 35_000;

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}

async function main() {
  console.log(`\n== P1 TREASURY QUALITY drill against ${API} ==`);
  await warm();
  const owner = campaignOwner('tearapart-p1');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  const traces = async (id) => (await api(`/api/agents/${id}/traces?limit=600`)).body?.records ?? [];

  const mkAudit = () => { const k = new PrivateKey(); return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from('{}').toString('base64') }; };
  const mkBody = (name, ben, target, topUp) => ({
    name, goal: { beneficiary: ben, targetBalanceWei: target.toString(), topUpWei: topUp.toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
    allowlist: [ben], ...mkAudit(),
  });

  // Scenario A: beneficiary BELOW target → should ACT (send exactly 0.002 to ben) then STAND DOWN.
  const benA = privateKeyToAccount(generatePrivateKey());
  const A = await api('/api/agents', { method: 'POST', body: mkBody(`p1q-A-below-${Date.now()}`, benA.address, parseEther('0.002'), parseEther('0.002')) });
  // Scenario B: beneficiary ABOVE target → should STAND DOWN every cycle.
  const benB = privateKeyToAccount(generatePrivateKey());
  const B = await api('/api/agents', { method: 'POST', body: mkBody(`p1q-B-above-${Date.now()}`, benB.address, parseEther('0.002'), parseEther('0.002')) });
  const agents = {
    A: { id: A.body?.agentId, acct: A.body?.accountAddr, ben: benA.address, want: 'ACT once (0.002 → ben) then STAND DOWN' },
    B: { id: B.body?.agentId, acct: B.body?.accountAddr, ben: benB.address, want: 'STAND DOWN every cycle (already above target)' },
  };
  console.log('agents:', JSON.stringify(agents, null, 0));
  if (!agents.A.id || !agents.B.id) { console.log('create failed', JSON.stringify(A.body).slice(0,200), JSON.stringify(B.body).slice(0,200)); return; }

  // Fund both accounts; pre-fund B's beneficiary ABOVE target (0.005 > 0.002).
  await waitReceipt(await opsWallet.sendTransaction({ to: agents.A.acct, value: parseEther('0.01') }));
  await waitReceipt(await opsWallet.sendTransaction({ to: agents.B.acct, value: parseEther('0.01') }));
  await waitReceipt(await opsWallet.sendTransaction({ to: agents.B.ben, value: parseEther('0.005') }));
  console.log(`funded A.acct, B.acct (0.01 each); pre-funded B.ben to 0.005 (above target 0.002)`);
  console.log(`A.ben start=${formatEther(await pub.getBalance({ address: agents.A.ben }))}, B.ben start=${formatEther(await pub.getBalance({ address: agents.B.ben }))}\n`);

  await api(`/api/agents/${agents.A.id}/start`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${agents.B.id}/start`, { method: 'POST', body: '{}' });

  for (let c = 1; c <= CYCLES; c++) {
    await sleep(CYCLE_MS);
    const balA = await pub.getBalance({ address: agents.A.ben });
    const balB = await pub.getBalance({ address: agents.B.ben });
    const trA = await traces(agents.A.id); const trB = await traces(agents.B.id);
    const actsA = trA.filter((r) => r.kind === 'action' && r.detail?.txHash).length;
    const actsB = trB.filter((r) => r.kind === 'action' && r.detail?.txHash).length;
    console.log(`cycle ${c}: A.ben=${formatEther(balA)} acts=${actsA} | B.ben=${formatEther(balB)} acts=${actsB}`);
  }

  await api(`/api/agents/${agents.A.id}/stop`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${agents.B.id}/stop`, { method: 'POST', body: '{}' });

  // ===== FULL DUMP for anchor judging =====
  for (const key of ['A', 'B']) {
    const ag = agents[key];
    const tr = await traces(ag.id);
    console.log(`\n========== AGENT ${key} (${ag.want}) ==========`);
    // every reasoning / inference / decision / action trace, full detail
    const relevant = tr.filter((r) => /reason|inference|decision|action|stand/i.test(r.kind) || r.detail?.reason || r.detail?.decision || r.detail?.rationale || r.detail?.text);
    for (const r of relevant) {
      const d = r.detail ?? {};
      const txt = d.text ?? d.rationale ?? d.reason ?? d.decision ?? JSON.stringify(d);
      console.log(`[seq ${r.seq ?? '?'} · ${r.kind}${d.txHash ? ' · tx ' + d.txHash.slice(0,10) : ''}] ${String(txt).replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    const acts = tr.filter((r) => r.kind === 'action' && r.detail?.txHash);
    for (const a of acts) {
      try { const rc = await pub.getTransactionReceipt({ hash: a.detail.txHash }); console.log(`  ACT tx ${a.detail.txHash.slice(0,12)} status=${rc.status} → verify recipient==${ag.ben}`); } catch {}
    }
    const bal = await pub.getBalance({ address: ag.ben });
    console.log(`  >>> ${key}: beneficiary final=${formatEther(bal)} 0G; total acts=${acts.length}; EXPECTED: ${ag.want}`);
    await api(`/api/agents/${ag.id}/revoke`, { method: 'POST' }).catch(() => {});
  }
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
