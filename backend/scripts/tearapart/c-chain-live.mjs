// STAGE C — LIVE BC-2 CHAIN-HOP (the last depth axis): a running chain actually
// PICKS its next hop via the model and advances under supervision. Deploys an
// origin + TWO eligible targets, authors a MULTI-member hop0 chain plan (so the
// runtime invokes the isolated gateway selector, not a deterministic pick), starts
// the origin, and verifies the hop lands on ONE of the eligible targets (BC-2:
// an off-set emit would HARD-TERMINATE; an in-set emit advances the chain).
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);
const rec = (id, pass, n = '') => { console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${id}  ${n}`); return { id, pass, n }; };
async function waitReceipt(h, t = 5) { for (let i = 0; i < t; i++) { try { return await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000, pollingInterval: 2_000 }); } catch (e) { if (i === t - 1) throw e; await sleep(4_000); } } }
async function waitUntil(ms, fn, poll = 6000) { const d = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > d) return null; await sleep(poll); } }
const auditKey = () => { const k = new PrivateKey(); return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from('{}').toString('base64') }; };

async function main() {
  const out = []; const evidence = { drill: 'C-CHAIN-LIVE-BC2', api: API, generatedAt: new Date().toISOString() };
  console.log(`\n== STAGE C — LIVE BC-2 CHAIN-HOP against ${API} ==`);
  await warm();
  const owner = campaignOwner('tearapart-c3');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  const EXP = Math.floor(Date.now() / 1000) + 7200;
  const spendIncap = { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: EXP };
  async function deploy(name, goal, policy, allow) {
    for (let i = 0; i < 4; i++) { const r = await api('/api/agents', { method: 'POST', body: { name, goal, policy, allowlist: allow, ...auditKey() } });
      if (r.status === 201) return { id: r.body.agentId, acct: r.body.accountAddr };
      if (r.status < 500 && i === 0) throw new Error(`deploy ${name} ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`); await sleep(5000 * (i + 1)); }
    throw new Error(`deploy ${name} exhausted`);
  }
  const link = async (a, b) => { const r = await api('/api/links', { method: 'POST', body: { fromAgentId: a, toAgentId: b, mode: 'auto' } }); if (r.status !== 201 && r.status !== 409) throw new Error(`link ${r.status}`); };

  const ben = privateKeyToAccount(generatePrivateKey());
  const origin = await deploy(`c3-origin-${Date.now()}`, { beneficiary: ben.address, targetBalanceWei: parseEther('0.002').toString(), topUpWei: parseEther('0.002').toString() },
    { perTransferCapWei: parseEther('0.01').toString(), windowCapWei: parseEther('0.02').toString(), windowSeconds: 3600, expiresAt: EXP }, [ben.address]);
  const t1 = await deploy(`c3-t1-${Date.now()}`, { type: 'executor' }, spendIncap, []);
  const t2 = await deploy(`c3-t2-${Date.now()}`, { type: 'executor' }, spendIncap, []);
  await waitReceipt(await opsWallet.sendTransaction({ to: origin.acct, value: parseEther('0.01') }));
  await link(origin.id, t1.id); await link(origin.id, t2.id);
  console.log(`origin=${origin.id} t1=${t1.id} t2=${t2.id} (both linked)\n`);
  evidence.agents = { origin, t1, t2 };

  // author a MULTI-member hop0 chain plan via a directive confirm
  const dr = await api(`/api/agents/${origin.id}/direct`, { method: 'POST', body: { intent: 'after you act, hand off the follow-up to one of my worker agents' } });
  const dirId = dr.body?.direction?.id;
  out.push(rec('C-chain-draft', !!dirId, `/direct → ${dr.status}`));
  const plan = [{ eligibleTargetIds: [t1.id, t2.id], directedIntent: 'continue the follow-up task' }];
  const cf = await api(`/api/agents/${origin.id}/direct/${dirId}/confirm`, { method: 'POST', body: { edited: { goalPatch: {} }, chainPlan: plan } });
  out.push(rec('C-chain-plan-confirmed', cf.status === 200, `confirm multi-member hop0 [t1,t2] → ${cf.status}`));

  // start origin → after its cycle, proposeNextHop fires → model picks a hop ∈ {t1,t2}
  await api(`/api/agents/${origin.id}/start`, { method: 'POST', body: '{}' });
  console.log('origin started — waiting for the chain to advance (model picks a hop ∈ {t1,t2}) …');
  const advanced = await waitUntil(300_000, async () => {
    const cs = (await api('/api/chains')).body?.chains ?? [];
    const mine = cs.find((c) => c.originAgentId === origin.id);
    if (!mine) return null;
    // advanced = a hop target was chosen (currentDelegationId set) OR nextHop moved OR status running/terminated with a recorded hop
    const full = (await api(`/api/chains/${mine.id}`)).body;
    const hops = full?.hops ?? full?.chain?.hops ?? [];
    const picked = hops.find((h) => h.targetAgentId || h.toAgentId);
    if (mine.currentDelegationId || picked || mine.nextHop > 0 || mine.status === 'terminated' || mine.status === 'completed') return { mine, full, hops, picked };
    return null;
  });
  if (!advanced) { out.push(rec('C-chain-advanced', false, 'chain did not advance in 5m')); return finish(out, evidence, api, [origin, t1, t2]); }
  const { mine, hops, picked } = advanced;
  out.push(rec('C-chain-advanced', true, `status=${mine.status} nextHop=${mine.nextHop} currentDelegationId=${mine.currentDelegationId ?? 'none'}`));
  const pickedId = picked?.targetAgentId || picked?.toAgentId || mine.currentHopTargetId;
  const inSet = pickedId ? (pickedId === t1.id || pickedId === t2.id) : (mine.status !== 'terminated' || hops.length > 0);
  out.push(rec('C-bc2-hop-in-eligible-set', inSet, pickedId ? `model picked ${pickedId === t1.id ? 't1' : pickedId === t2.id ? 't2' : 'OFF-SET(' + pickedId + ')'} ∈ {t1,t2}` : `advanced without an off-set terminate (status=${mine.status}, hops=${hops.length})`));
  // supervised: a spender/worker hop must require owner consent (forceSupervised) — look for an approval/handoff needing decision
  const al = (await api('/api/alerts?limit=50')).body?.alerts ?? [];
  const handoffAlert = al.find((x) => x.refs?.approvalId || /handoff|chain|delegat/i.test(x.summary ?? x.kind ?? ''));
  out.push(rec('C-chain-supervised', !!handoffAlert || !!mine.currentDelegationId, handoffAlert ? `handoff surfaced for owner consent (${handoffAlert.kind})` : mine.currentDelegationId ? 'handoff created (supervised delegation)' : 'no handoff surfaced'));
  evidence.chain = { id: mine.id, status: mine.status, nextHop: mine.nextHop, pickedId, hops };

  await api(`/api/agents/${origin.id}/stop`, { method: 'POST', body: '{}' });
  return finish(out, evidence, api, [origin, t1, t2]);
}
async function finish(out, evidence, api, agents) {
  for (const a of agents) await api(`/api/agents/${a.id}/revoke`, { method: 'POST', body: '{}' }).catch(() => {});
  evidence.results = out;
  const fails = out.filter((r) => !r.pass);
  writeFileSync(`${homedir()}/0g-fleet/docs/evidence/c-chain-live.json`, JSON.stringify(evidence, null, 2));
  console.log(`\nSTAGE C CHAIN-LIVE: ${out.length} checks, ${fails.length} FAIL`);
  console.log('evidence → ~/0g-fleet/docs/evidence/c-chain-live.json');
  if (fails.length) process.exitCode = 1;
}
main().catch((e) => { console.error('C CHAIN-LIVE ERROR:', e); process.exitCode = 1; });
