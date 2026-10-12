// P2 BEHAVIORAL QUALITY — real sentinel→executor handoff (the pair FLOW I only
// connected before). Measures:
//   Q1 S correctly REQUESTS when below target (spend-incapable, delegates not sends);
//      E correctly RE-VALIDATES + FULFILS to the beneficiary (exact amount, right recipient).
//   Q2 both reason soundly; E treats the inbound delegation as UNTRUSTED input re-checked
//      against ITS own policy (not blind obedience). (E's full deliberation captured via SSE.)
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}

async function main() {
  console.log(`\n== P2 BEHAVIORAL — sentinel→executor real handoff ==`);
  await warm();
  const owner = campaignOwner('tearapart-p1');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  const traces = async (id) => (await api(`/api/agents/${id}/traces?limit=400`)).body?.records ?? [];
  const mkAudit = () => { const k = new PrivateKey(); return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from('{}').toString('base64') }; };

  const ben = privateKeyToAccount(generatePrivateKey()); // below target → should trigger a request
  // Sentinel: spend-incapable (caps 0, allowlist []), watches ben, requests top-up.
  const S = await api('/api/agents', { method: 'POST', body: {
    name: `p2q-sentinel-${Date.now()}`,
    goal: { type: 'sentinel', beneficiary: ben.address, targetBalanceWei: parseEther('0.004').toString(), topUpWei: parseEther('0.002').toString() },
    policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: Math.floor(Date.now()/1000)+7200 },
    allowlist: [], ...mkAudit(),
  }});
  // Executor: inbound-driven, funded, allowlists ben so it CAN fulfil.
  const E = await api('/api/agents', { method: 'POST', body: {
    name: `p2q-executor-${Date.now()}`,
    goal: { type: 'executor' },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now()/1000)+7200 },
    allowlist: [ben.address], ...mkAudit(),
  }});
  const sid = S.body?.agentId, eid = E.body?.agentId, eacct = E.body?.accountAddr;
  if (!sid || !eid) { console.log('create failed', JSON.stringify(S.body).slice(0,200), JSON.stringify(E.body).slice(0,200)); return; }
  console.log(`sentinel=${sid}  executor=${eid} acct=${eacct}  beneficiary=${ben.address} (0, below target 0.004)`);

  // Link S→E (auto = no owner approval needed for the handoff).
  const link = await api('/api/links', { method: 'POST', body: { fromAgentId: sid, toAgentId: eid, mode: 'auto' } });
  console.log(`link S→E: ${link.status} ${link.body?.link?.id ?? JSON.stringify(link.body).slice(0,120)}`);

  // Fund E's account so it can fulfil a request.
  await waitReceipt(await opsWallet.sendTransaction({ to: eacct, value: parseEther('0.01') }));
  console.log(`funded executor account 0.01\n`);

  // Capture the EXECUTOR's full deliberation (the interesting re-validation) via SSE.
  const ac = new AbortController();
  const streamP = (async () => {
    const res = await fetch(`${API}/api/agents/${eid}/stream`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', n = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
      for (const ev of evs) { const dl = ev.split('\n').find((l) => l.startsWith('data:')); if (!dl) continue;
        let d; try { d = JSON.parse(dl.slice(5).trim()); } catch { continue; }
        if (d.type === 'reasoning' && d.text) { n++; console.log(`\n──── EXECUTOR reasoning #${n} ────\n${d.text}\n`); }
      } } } catch (e) { if (e.name !== 'AbortError') console.log('stream err', e.message); }
  })();

  await api(`/api/agents/${sid}/start`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${eid}/start`, { method: 'POST', body: '{}' });

  for (let c = 1; c <= 6; c++) {
    await sleep(35_000);
    const benBal = await pub.getBalance({ address: ben.address });
    const tS = await traces(sid), tE = await traces(eid);
    const delegsS = tS.filter((r) => /deleg|request/i.test(r.kind) || r.detail?.kind === 'transfer.request');
    const actsE = tE.filter((r) => r.kind === 'action' && r.detail?.txHash);
    console.log(`cycle ${c}: ben=${formatEther(benBal)} | S delegations=${delegsS.length} | E acts=${actsE.length}`);
  }
  ac.abort(); await streamP.catch(() => {});
  await api(`/api/agents/${sid}/stop`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${eid}/stop`, { method: 'POST', body: '{}' });

  // Dump the handoff flow.
  for (const [label, id] of [['SENTINEL', sid], ['EXECUTOR', eid]]) {
    const tr = await traces(id);
    console.log(`\n===== ${label} traces =====`);
    for (const r of tr.filter((r) => /reason|decision|action|deleg|request|inbound/i.test(r.kind) || r.detail?.reason || r.detail?.summary)) {
      const d = r.detail ?? {};
      console.log(`[seq ${r.seq ?? '?'} · ${r.kind}] ${String(d.summary ?? d.reason ?? JSON.stringify(d)).replace(/\s+/g,' ').slice(0,260)}`);
    }
  }
  const benFinal = await pub.getBalance({ address: ben.address });
  console.log(`\n>>> beneficiary final=${formatEther(benFinal)} 0G (target 0.004). EXPECTED: S requests → E fulfils → ben rises toward target.`);
  await api(`/api/agents/${sid}/revoke`, { method: 'POST' }).catch(() => {});
  await api(`/api/agents/${eid}/revoke`, { method: 'POST' }).catch(() => {});
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
