// Stage A2 — Liveness (P2, one-loop-cycle bar) + product-visible cage (P1.4/P1.6)
// + C4/C5/C6/C9/C11 mechanical. Loop cycle = 30s; liveness budget 90s.
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { readFileSync } from 'node:fs';
import {
  API, campaignOwner, privyLogin, makeApi, warm, sleep, record, section, summary, clients, env,
} from './common.mjs';

const CYCLE_MS = 30_000;
const LIVENESS_BUDGET_MS = 90_000;

const owner = campaignOwner('owner-a');
await warm(API);
const token = await privyLogin(owner);
const api = makeApi(token);
const fixtures = JSON.parse(readFileSync(new URL('./state/a1-fixtures.json', import.meta.url), 'utf8'));
const og = clients(16602);

const audit = () => {
  const k = new PrivateKey();
  return {
    auditPubKey: k.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'rh2-a2' })).toString('base64'),
  };
};

// --- SSE capture: collect event kinds for an agent over a window (P2.5) ---
function sseCapture(agentId, ms) {
  const events = [];
  const ctl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`${API}/api/agents/${agentId}/stream`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: ctl.signal,
      });
      if (!res.ok) { events.push({ error: res.status }); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1];
          if (ev) events.push({ ev, t: Date.now() });
        }
      }
    } catch { /* aborted */ }
  })();
  setTimeout(() => ctl.abort(), ms);
  return { events, done };
}

async function pollTraces(agentId, pred, budgetMs, everyMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const tr = await api(`/api/agents/${agentId}/traces?limit=200`);
    const recs = tr.body.records ?? [];
    const hit = pred(recs);
    if (hit) return { hit, ms: Date.now() - t0, recs };
    if (Date.now() - t0 > budgetMs) return { hit: null, ms: Date.now() - t0, recs };
    await sleep(everyMs);
  }
}

// ---------- C4 fleet + foreign-id isolation ----------
section('A2 / C4 Fleet');
{
  const r = await api('/api/agents?limit=50');
  const ids = (r.body.agents ?? []).map((a) => a.id);
  record('C4-H1-list', r.status === 200 && ids.includes(fixtures.treasury.agentId), `${ids.length} agents listed`);
  const ownerB = campaignOwner('owner-b');
  const apiB = makeApi(await privyLogin(ownerB));
  const f = await apiB(`/api/agents/${fixtures.treasury.agentId}`);
  record('C4-A1-foreign-404', f.status === 404, `owner-b fetch of owner-a agent -> ${f.status}`);
}

// ---------- P2 liveness: TREASURY on 0G (full 5-link isolation) ----------
section('A2 / P2 Treasury liveness (0G, one-cycle bar)');
const T = fixtures.treasury;
{
  const d0 = await api(`/api/agents/${T.agentId}`);
  const ben = d0.body?.goal?.beneficiary;
  record('P2.1-runtime-reg', d0.status === 200 && d0.body.status, `status after create = ${d0.body.status} (born ${d0.body.status === 'paused' ? 'paused — start required (UI suspect #1)' : d0.body.status})`);

  // fund the account (C5) — stimulus already present: beneficiary balance 0 < target
  const fundTx = await og.opsWallet.sendTransaction({ to: T.accountAddr, value: parseEther('0.02') });
  await og.pub.waitForTransactionReceipt({ hash: fundTx });
  record('C5-H1-fund', true, `funded 0.02 0G ${fundTx.slice(0, 18)}…`);

  const cap = sseCapture(T.agentId, LIVENESS_BUDGET_MS + 20_000);
  const t0 = Date.now();
  const st = await api(`/api/agents/${T.agentId}/start`, { method: 'POST', body: '{}' });
  record('C6-H1-start', st.status < 300, `start -> ${st.status}`);

  const inf = await pollTraces(T.agentId, (rs) => rs.find((r) => r.kind === 'inference'), LIVENESS_BUDGET_MS);
  record('P2.3-inference', !!inf.hit, inf.hit ? `inference trace after ${Math.round(inf.ms / 1000)}s` : `NO inference within ${LIVENESS_BUDGET_MS / 1000}s — link 3 severed (0G Compute or LLM limiter)`);

  const act = await pollTraces(T.agentId, (rs) => rs.find((r) => r.kind === 'action' && (r.detail?.txHash || r.response?.txHash)), LIVENESS_BUDGET_MS);
  const actMs = Date.now() - t0;
  const oneCycle = actMs <= LIVENESS_BUDGET_MS;
  let benBal = 0n;
  if (ben) benBal = await og.pub.getBalance({ address: ben });
  record('P2.4-action-one-cycle', !!act.hit && benBal > 0n, act.hit ? `action tx in ${Math.round(actMs / 1000)}s ${oneCycle ? '(within one cycle ✓)' : '(LATE — >1 cycle)'} | beneficiary now ${formatEther(benBal)}` : `NO action within budget; beneficiary ${formatEther(benBal)}`);

  await cap.done;
  const kinds = [...new Set(cap.events.map((e) => e.ev))];
  record('P2.5-sse-live', cap.events.some((e) => e.ev === 'reasoning' || e.ev === 'trace'), `SSE events during window: [${kinds.join(',')}] (${cap.events.length} total)`);

  // C6 idempotency
  const st2 = await api(`/api/agents/${T.agentId}/start`, { method: 'POST', body: '{}' });
  record('C6-S1-double-start', st2.status < 300, `second start -> ${st2.status} (idempotent)`);
  const sp = await api(`/api/agents/${T.agentId}/stop`, { method: 'POST', body: '{}' });
  const sp2 = await api(`/api/agents/${T.agentId}/stop`, { method: 'POST', body: '{}' });
  record('C6-S2-stop-idem', sp.status < 300 && sp2.status < 300, `stop,stop -> ${sp.status},${sp2.status}`);
}

// ---------- P2 liveness: BAND HERO on RH 46630 (the demo chain) ----------
section('A2 / P2 Band-hero liveness (RH 46630)');
{
  // band hero from the C3 retest
  const H = { agentId: '7451fc0c-7750-4a45-96fd-90e24e033e64', accountAddr: '0xF2c06CCa6B1Cd3d5Ee4E2e61EB5bBc7AD82a5FC8' };
  const rh = clients(46630);
  try {
    const fundTx = await rh.opsWallet.sendTransaction({ to: H.accountAddr, value: parseEther('0.001') });
    await rh.pub.waitForTransactionReceipt({ hash: fundTx });
    record('C5-H2-fund-rh', true, `funded 0.001 RH ETH ${fundTx.slice(0, 18)}…`);
  } catch (e) {
    record('C5-H2-fund-rh', false, `RH fund failed: ${e.shortMessage ?? e.message}`.slice(0, 160));
  }
  const t0 = Date.now();
  const st = await api(`/api/agents/${H.agentId}/start`, { method: 'POST', body: '{}' });
  record('C6-H2-start-rh', st.status < 300, `start -> ${st.status}`);
  const act = await pollTraces(H.agentId, (rs) => rs.find((r) => r.kind === 'action' && (r.detail?.txHash || r.response?.txHash)), LIVENESS_BUDGET_MS);
  const inf = act.recs.some((r) => r.kind === 'inference');
  const ben = '0x1111111111111111111111111111111111111112';
  const benBal = await rh.pub.getBalance({ address: ben }).catch(() => -1n);
  record('P2.4-rh-action', !!act.hit, act.hit ? `RH action in ${Math.round((Date.now() - t0) / 1000)}s | ben ${benBal >= 0n ? formatEther(benBal) : '?'} RH ETH` : `no RH action in budget (inference=${inf}) — band hero idle on demo chain`);
  await api(`/api/agents/${H.agentId}/stop`, { method: 'POST', body: '{}' });
}

// ---------- P2 sentinel→executor + C11 link + C9 approval ----------
section('A2 / P2 Sentinel→Executor (delegation liveness, supervised)');
{
  const ben2 = privateKeyToAccount(generatePrivateKey()).address;
  const mk = async (name, body) => {
    const r = await api('/api/agents', { method: 'POST', body });
    if (r.status !== 201) { record(`A2-create-${name}`, false, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`); return null; }
    return r.body;
  };
  const sen = await mk('sentinel2', {
    name: 'a2 sentinel', goal: { type: 'sentinel', beneficiary: ben2, targetBalanceWei: parseEther('0.004').toString(), topUpWei: parseEther('0.001').toString() },
    policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 604800 },
    allowlist: [], ...audit(),
  });
  const exe = await mk('executor2', {
    name: 'a2 executor', goal: { type: 'executor' },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 604800 },
    allowlist: [ben2], ...audit(),
  });
  if (sen && exe) {
    const link = await api('/api/links', { method: 'POST', body: { fromAgentId: sen.agentId, toAgentId: exe.agentId, mode: 'supervised' } });
    record('C11-H1-link', link.status < 300, `supervised link -> ${link.status} ${link.body.id ?? ''}`);
    const fundTx = await og.opsWallet.sendTransaction({ to: exe.accountAddr, value: parseEther('0.02') });
    await og.pub.waitForTransactionReceipt({ hash: fundTx });

    await api(`/api/agents/${exe.agentId}/start`, { method: 'POST', body: '{}' });
    const t0 = Date.now();
    await api(`/api/agents/${sen.agentId}/start`, { method: 'POST', body: '{}' });

    // sentinel must DELEGATE (never act): watch for delegate trace
    const del = await pollTraces(sen.agentId, (rs) => rs.find((r) => r.kind === 'delegate'), LIVENESS_BUDGET_MS * 2);
    const senActed = del.recs.some((r) => r.kind === 'action');
    record('P2-sentinel-delegates', !!del.hit && !senActed, del.hit ? `delegate in ${Math.round(del.ms / 1000)}s; sentinel action traces=${senActed} (must be false)` : 'no delegation within 2 cycles');

    // supervised: approval should appear → approve it (C9-H1)
    let approved = false;
    for (let i = 0; i < 24 && !approved; i++) {
      const al = await api('/api/alerts?status=unread&limit=50');
      const a = (al.body.alerts ?? []).find((x) => x.kind === 'approval_required' && x.approvalId);
      if (a) {
        const dec = await api(`/api/approvals/${a.approvalId}`, { method: 'POST', body: { decision: 'approve', reason: 'a2 supervised handoff' } });
        record('C9-H1-approve', dec.status < 300, `approve ${a.approvalId.slice(0, 8)}… -> ${dec.status}`);
        approved = true;
        // C9-A1 replay
        const re = await api(`/api/approvals/${a.approvalId}`, { method: 'POST', body: { decision: 'approve' } });
        record('C9-A1-replay', re.status >= 400, `replay decision -> ${re.status}`);
      } else await sleep(5000);
    }
    if (!approved) record('C9-H1-approve', false, 'no approval_required alert appeared within 2 min (supervised gate missing?)');

    // executor acts within a cycle of approval
    const act = await pollTraces(exe.agentId, (rs) => rs.find((r) => r.kind === 'action' && (r.detail?.txHash || r.response?.txHash)), LIVENESS_BUDGET_MS * 2);
    const b2 = await og.pub.getBalance({ address: ben2 });
    record('P2-executor-acts', !!act.hit && b2 > 0n, act.hit ? `executor tx in ${Math.round(act.ms / 1000)}s (from start+${Math.round((Date.now() - t0) / 1000)}s); ben2=${formatEther(b2)}` : `no executor action; ben2=${formatEther(b2)}`);

    await api(`/api/agents/${sen.agentId}/stop`, { method: 'POST', body: '{}' });
    await api(`/api/agents/${exe.agentId}/stop`, { method: 'POST', body: '{}' });
  }
}

// ---------- P1.4 expiry lapse + P1.6 revoke mid-loop ----------
section('A2 / P1.4 expiry + P1.6 revoke mid-loop');
{
  const benX = privateKeyToAccount(generatePrivateKey()).address;
  const r = await api('/api/agents', { method: 'POST', body: {
    name: 'a2 shortfuse', goal: { beneficiary: benX, targetBalanceWei: parseEther('0.004').toString(), topUpWei: parseEther('0.001').toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 150 },
    allowlist: [benX], ...audit() } });
  if (r.status === 201) {
    const A = r.body;
    const fundTx = await og.opsWallet.sendTransaction({ to: A.accountAddr, value: parseEther('0.01') });
    await og.pub.waitForTransactionReceipt({ hash: fundTx });
    await api(`/api/agents/${A.agentId}/start`, { method: 'POST', body: '{}' });
    // first action should land pre-expiry
    const act = await pollTraces(A.agentId, (rs) => rs.find((x) => x.kind === 'action'), 90_000);
    // wait past expiry, then expect error/block surfaced, not silence
    await sleep(120_000);
    const post = await pollTraces(A.agentId, (rs) => rs.filter((x) => (x.kind === 'error' || x.kind === 'block') && Date.now() / 1000 - 300 < (x.ts ?? Date.now() / 1000)).length > 0 ? rs : null, 70_000);
    record('P1.4-expiry-surfaced', !!act.hit && !!post.hit, `pre-expiry action=${!!act.hit}; post-expiry error/block trace=${!!post.hit} (silent lapse = FAIL)`);
    await api(`/api/agents/${A.agentId}/stop`, { method: 'POST', body: '{}' });
  } else record('P1.4-expiry-surfaced', false, `shortfuse create failed ${r.status}`);

  // P1.6: revoke the (running) treasury mid-loop
  await api(`/api/agents/${T.agentId}/start`, { method: 'POST', body: '{}' });
  await sleep(3000);
  const rev = await api(`/api/agents/${T.agentId}/revoke`, { method: 'POST', body: '{}' });
  await sleep(8000);
  const d = await api(`/api/agents/${T.agentId}`);
  let onchain = null;
  try {
    onchain = await og.pub.readContract({ address: T.accountAddr, abi: [{ name: 'revoked', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }], functionName: 'revoked' });
  } catch { /* keep null */ }
  record('P1.6-revoke-midloop', rev.status < 300 && d.body.status === 'revoked' && onchain === true, `revoke=${rev.status}, backend=${d.body.status}, onchain revoked()=${onchain}`);
  const st = await api(`/api/agents/${T.agentId}/start`, { method: 'POST', body: '{}' });
  record('P1.6b-start-after-revoke', st.status >= 400, `start revoked agent -> ${st.status} (must refuse)`);
}

summary('Stage A2');
