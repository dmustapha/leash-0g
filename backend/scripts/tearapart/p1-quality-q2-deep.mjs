// P1 TREASURY QUALITY — DEEP Q2 (reasoning soundness, full deliberation).
// The plaintext traces only carry the FINAL one-line decision reason. The full
// model "thinking" (the §1 "see why" headline) streams live as SSE `reasoning`
// events (treasury-graph.ts:533 hub.emit('reasoning', {text})). We connect to the
// owner /stream, capture the FULL reasoning text per cycle, and the ANCHOR grades:
//   - does it READ the observation correctly (balance vs target, account balance)?
//   - does it APPLY the rules in order (the TREASURY_PROMPT ladder)?
//   - is the LOGIC valid → the right decision, for the right reason (not right-by-luck)?
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);
const CAPTURE_MS = 160_000; // ~4-5 cycles

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}

async function main() {
  console.log(`\n== P1 TREASURY QUALITY — DEEP Q2 (full reasoning deliberation) ==`);
  await warm();
  const owner = campaignOwner('tearapart-p1');
  const token = await privyLogin(owner);
  const api = makeApi(token);

  // Below-target, funded → acts cycle 1 then stands down → captures reasoning for BOTH branches.
  const ben = privateKeyToAccount(generatePrivateKey());
  const k = new PrivateKey();
  const created = await api('/api/agents', { method: 'POST', body: {
    name: `p1q-deep-${Date.now()}`,
    goal: { beneficiary: ben.address, targetBalanceWei: parseEther('0.002').toString(), topUpWei: parseEther('0.002').toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
    allowlist: [ben.address], auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from('{}').toString('base64'),
  }});
  const id = created.body?.agentId; const acct = created.body?.accountAddr;
  if (!id) { console.log('create failed', JSON.stringify(created.body).slice(0, 200)); return; }
  await waitReceipt(await opsWallet.sendTransaction({ to: acct, value: parseEther('0.01') }));
  console.log(`agent=${id} acct=${acct} ben=${ben.address} (below target 0.002, funded) — capturing ${CAPTURE_MS/1000}s of reasoning\n`);

  // Open SSE to the owner stream; capture `reasoning` events (full text).
  const ac = new AbortController();
  const streamP = (async () => {
    const res = await fetch(`${API}/api/agents/${id}/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', cycle = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n'); buf = events.pop() ?? '';
        for (const ev of events) {
          const dataLine = ev.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let d; try { d = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (d.type === 'reasoning' && d.text) {
            cycle++;
            console.log(`\n────────── CYCLE ${cycle} reasoning (full) ──────────\n${d.text}\n`);
          } else if (d.type === 'trace' && (d.kind === 'action' || d.kind === 'decision')) {
            console.log(`   >> ${d.kind}: ${JSON.stringify(d.detail ?? d).slice(0, 200)}`);
          }
        }
      }
    } catch (e) { if (e.name !== 'AbortError') console.log('stream err', e.message); }
  })();

  await api(`/api/agents/${id}/start`, { method: 'POST', body: '{}' });
  await sleep(CAPTURE_MS);
  ac.abort();
  await streamP.catch(() => {});
  await api(`/api/agents/${id}/stop`, { method: 'POST', body: '{}' });
  console.log(`\nbeneficiary final=${formatEther(await pub.getBalance({ address: ben.address }))} 0G (target 0.002)`);
  await api(`/api/agents/${id}/revoke`, { method: 'POST' }).catch(() => {});
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
