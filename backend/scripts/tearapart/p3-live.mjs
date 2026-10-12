// P3-LIVE — daily-loop boundary rail against the tear-apart service + 0G testnet.
// Proves the require_approval / limit_hit boundaries the daily loop surfaces:
//   SECTION A (deterministic): over-window boundary -> EXACTLY ONE limit_hit alert
//     (DB-deduped) + 0 futile acts across >=3 cycles after the window is exhausted.
//   SECTION B: a require_approval boundary -> alert on owner SSE (captured live) +
//     the alert feed -> inline APPROVE (POST /api/approvals/:id) -> the held inference
//     proceeds -> REAL on-chain act with consent.seq < action.seq, receipt re-witnessed.
//   SECTION C: a require_approval boundary -> inline DENY -> NO act.
//
// Boundary source for B/C: the owner-set gateway `require_approval` RULE
// (PATCH /api/agents/:id/rules). The treasury OVER-PER-TRANSFER-CAP boundary is
// unreachable live by configuration — doubly guarded: (1) the create schema rejects
// goal.topUpWei > policy.perTransferCapWei (owner-routes.ts:429), and (2) the prompt
// tells the model to self-cap and never propose over-cap (prompt.ts:145). So it fires
// only on MODEL MISBEHAVIOR and cannot be driven without mocking the remote model.
// The gateway require_approval rule is a real §3b daily-loop decision surface, rides
// the IDENTICAL consent rail (createApproval -> approval_required alert + SSE 'approval'
// -> POST /api/approvals/:id -> consent-before-forward), and on approve the forwarded
// inference leads the agent to act on-chain. (Telegram delivery needs a linked chat =
// Dami-paired; in-suite proven telegram.test.ts + live webhook healthy SCOPE-I-9.)
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602; // 0G Galileo
const { pub, opsWallet } = clients(CHAIN);
const results = [];
const rec = (id, pass, n = '') => { results.push({ id, pass }); console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${id}  ${n}`); };
const note = (id, msg) => console.log(`•  ${id}  ${msg}`);

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}
async function waitUntil(timeoutMs, fn, poll = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) return null; await sleep(poll); }
}
const auditKey = () => {
  const k = new PrivateKey();
  return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'p3-live' })).toString('base64') };
};

async function main() {
  console.log(`\n== P3-LIVE against ${API} (chain ${CHAIN}) ==`);
  await warm();
  const owner = campaignOwner('tearapart-p3');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  const traces = async (id) => (await api(`/api/agents/${id}/traces?limit=300`)).body?.records ?? [];
  const acts = async (id) => (await traces(id)).filter((r) => r.kind === 'action' && r.detail?.txHash);
  const alerts = async () => (await api('/api/alerts?limit=100')).body?.alerts ?? [];

  // Create with retry on 5xx — a 0G V4 deploy can transiently 500 (RPC/gas-floor).
  async function createAgent(name, goal, policy, beneficiary) {
    const body = { name, goal, policy, allowlist: [beneficiary.address], ...auditKey() };
    let created;
    for (let i = 0; i < 4; i++) {
      created = await api('/api/agents', { method: 'POST', body });
      if (created.status === 201) break;
      console.log(`  create attempt ${i + 1} -> ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
      if (created.status < 500) break; // 4xx is deterministic, don't retry
      await sleep(6000);
    }
    const agentId = created.body?.agentId ?? created.body?.id;
    const accountAddr = created.body?.accountAddr ?? created.body?.agent?.accountAddr;
    return { created, agentId, accountAddr };
  }

  // Live SSE capture: read /api/agents/:id/stream for `ms`, return raw frames seen.
  async function captureSse(agentId, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    let buf = '';
    try {
      const res = await fetch(`${API}/api/agents/${agentId}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    } catch { /* aborted at timeout — expected */ }
    finally { clearTimeout(t); }
    return buf;
  }

  // ======================================================================
  // SECTION A — over-window boundary -> exactly ONE limit_hit + 0 futile
  // ======================================================================
  console.log('\n--- SECTION A: over-window limit_hit (deterministic) ---');
  {
    const ben = privateKeyToAccount(generatePrivateKey());
    const goal = { beneficiary: ben.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.003').toString() };
    const policy = { perTransferCapWei: parseEther('0.003').toString(), windowCapWei: parseEther('0.003').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 };
    const { created, agentId, accountAddr } = await createAgent(`p3-limithit-${Date.now()}`, goal, policy, ben);
    rec('P3-LIVE-A-create', created.status === 201 && !!agentId, `create -> ${created.status}; acct=${accountAddr}`);
    if (agentId) {
      await waitReceipt(await opsWallet.sendTransaction({ to: accountAddr, value: parseEther('0.02') }));
      await api(`/api/agents/${agentId}/start`, { method: 'POST', body: '{}' });
      const firstAct = await waitUntil(150_000, async () => (await acts(agentId))[0] ?? null);
      rec('P3-LIVE-A-first-act', !!firstAct, firstAct ? `window-spending top-up tx=${firstAct.detail.txHash} (seq ${firstAct.seq})` : 'no first act within 150s');
      const limitHit = await waitUntil(150_000, async () => (await alerts()).find((x) => x.agentId === agentId && (x.kind === 'limit_hit' || /window/i.test(x.summary ?? ''))) ?? null);
      rec('P3-LIVE-A-limit_hit-fires', !!limitHit, limitHit ? `limit_hit: "${(limitHit.summary ?? '').slice(0, 90)}"` : 'no limit_hit alert');
      await sleep(80_000); // >=2 more cycles
      const lh = (await alerts()).filter((x) => x.agentId === agentId && (x.kind === 'limit_hit' || /window/i.test(x.summary ?? '')));
      rec('P3-LIVE-A-exactly-one-limit_hit', lh.length === 1, `limit_hit alert count = ${lh.length} (must be 1, DB-deduped by boundary key)`);
      const n = (await acts(agentId)).length;
      rec('P3-LIVE-A-zero-futile', n === 1, `total on-chain acts = ${n} (must be 1: the window-spending top-up, then damped stand-downs)`);
      await api(`/api/agents/${agentId}/revoke`, { method: 'POST' }).catch(() => {});
    }
  }

  // ======================================================================
  // SECTION B — require_approval (gateway rule) -> APPROVE -> on-chain act
  // ======================================================================
  console.log('\n--- SECTION B: require_approval -> APPROVE (gateway rule) ---');
  {
    const ben = privateKeyToAccount(generatePrivateKey());
    const goal = { beneficiary: ben.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.003').toString() };
    const policy = { perTransferCapWei: parseEther('0.003').toString(), windowCapWei: parseEther('0.02').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 };
    const { created, agentId, accountAddr } = await createAgent(`p3-approve-${Date.now()}`, goal, policy, ben);
    rec('P3-LIVE-B-create', created.status === 201 && !!agentId, `create -> ${created.status}; acct=${accountAddr}`);
    if (agentId) {
      await waitReceipt(await opsWallet.sendTransaction({ to: accountAddr, value: parseEther('0.02') }));
      const bal0 = await pub.getBalance({ address: ben.address });
      // Owner sets a require_approval gateway rule matching a token always present in
      // the treasury inference body (the beneficiary address appears in observation.goal).
      const needle = ben.address.toLowerCase();
      const patched = await api(`/api/agents/${agentId}/rules`, { method: 'PATCH', body: { rules: [{ action: 'require_approval', match: needle }] } });
      rec('P3-LIVE-B-rule-set', patched.status === 200, `PATCH /rules require_approval match=${needle.slice(0, 10)}… -> ${patched.status}`);
      // Capture the live SSE while the agent starts and the inference is held.
      const ssePromise = captureSse(agentId, 150_000);
      await api(`/api/agents/${agentId}/start`, { method: 'POST', body: '{}' });
      const al = await waitUntil(150_000, async () => (await alerts()).find((x) => x.agentId === agentId && (x.kind === 'approval_required' || x.refs?.approvalId)) ?? null);
      rec('P3-LIVE-B-approval-alert', !!al, al ? `approval_required alert: "${(al.summary ?? '').slice(0, 80)}" approvalId=${al.refs?.approvalId}` : 'no approval alert within 150s');
      if (al) {
        rec('P3-LIVE-B-alert-class-decision', al.class === 'decision', `alert class=${al.class} (decision rail)`);
        const approvalId = al.refs.approvalId;
        const preActs = (await acts(agentId)).length;
        const dec = await api(`/api/approvals/${approvalId}`, { method: 'POST', body: { decision: 'approve', reason: 'p3-live approve' } });
        rec('P3-LIVE-B-approve-200', dec.status === 200, `POST /api/approvals/${approvalId} approve -> ${dec.status}`);
        // Remove the rule so subsequent cycles aren't re-held and the agent can act.
        await api(`/api/agents/${agentId}/rules`, { method: 'PATCH', body: { rules: [] } });
        const act = await waitUntil(150_000, async () => { const l = await acts(agentId); return l.length > preActs ? l[l.length - 1] : null; });
        rec('P3-LIVE-B-act-after-approve', !!act, act ? `on-chain act after approve tx=${act.detail.txHash} (seq ${act.seq})` : 'no act within 150s of approve');
        if (act) {
          const tr = await traces(agentId);
          const consent = tr.find((r) => r.kind === 'consent' && r.approvalId === approvalId);
          rec('P3-LIVE-B-consent-before-act', !!consent && consent.seq < act.seq, consent ? `consent.seq ${consent.seq} < action.seq ${act.seq}` : 'no consent trace for the approval');
          const rcpt = await waitReceipt(act.detail.txHash);
          const bal1 = await pub.getBalance({ address: ben.address });
          rec('P3-LIVE-B-receipt-rewitnessed', rcpt?.status === 'success' && bal1 > bal0, `receipt.status=${rcpt?.status} block=${rcpt?.blockNumber}; beneficiary ${formatEther(bal0)} -> ${formatEther(bal1)} 0G`);
        }
        const sse = await ssePromise;
        const sawApprovalEvent = /event:\s*approval/.test(sse) && (approvalId ? sse.includes(approvalId) : true);
        rec('P3-LIVE-B-sse-approval-event', sawApprovalEvent, sawApprovalEvent ? `owner SSE carried event:approval (approvalId present=${sse.includes(approvalId)})` : `no event:approval in ${sse.length}B of captured stream`);
        note('P3-LIVE-B-telegram', 'live Telegram delivery needs a linked chat (Dami-paired); in-suite proven (telegram.test.ts) + webhook healthy (SCOPE-I-9).');
      } else {
        await ssePromise.catch(() => {});
      }
      await api(`/api/agents/${agentId}/revoke`, { method: 'POST' }).catch(() => {});
    }
  }

  // ======================================================================
  // SECTION C — require_approval (gateway rule) -> DENY -> no act
  // ======================================================================
  console.log('\n--- SECTION C: require_approval -> DENY (gateway rule) ---');
  {
    const ben = privateKeyToAccount(generatePrivateKey());
    const goal = { beneficiary: ben.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.003').toString() };
    const policy = { perTransferCapWei: parseEther('0.003').toString(), windowCapWei: parseEther('0.02').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 };
    const { created, agentId, accountAddr } = await createAgent(`p3-deny-${Date.now()}`, goal, policy, ben);
    rec('P3-LIVE-C-create', created.status === 201 && !!agentId, `create -> ${created.status}; acct=${accountAddr}`);
    if (agentId) {
      await waitReceipt(await opsWallet.sendTransaction({ to: accountAddr, value: parseEther('0.02') }));
      const needle = ben.address.toLowerCase();
      await api(`/api/agents/${agentId}/rules`, { method: 'PATCH', body: { rules: [{ action: 'require_approval', match: needle }] } });
      await api(`/api/agents/${agentId}/start`, { method: 'POST', body: '{}' });
      const al = await waitUntil(150_000, async () => (await alerts()).find((x) => x.agentId === agentId && x.refs?.approvalId) ?? null);
      rec('P3-LIVE-C-approval-alert', !!al, al ? `approvalId=${al.refs?.approvalId}` : 'no approval alert within 150s');
      if (al) {
        // Keep the rule in place so a denied cycle can't be followed by a free act.
        const dec = await api(`/api/approvals/${al.refs.approvalId}`, { method: 'POST', body: { decision: 'deny', reason: 'p3-live deny' } });
        rec('P3-LIVE-C-deny-200', dec.status === 200, `POST deny -> ${dec.status}`);
        await sleep(80_000); // > 2 cycles; each inference is re-held then denied by owner-absence/timeout — never acts
        const n = (await acts(agentId)).length;
        rec('P3-LIVE-C-no-act-after-deny', n === 0, `on-chain acts after deny = ${n} (must be 0)`);
      }
      await api(`/api/agents/${agentId}/revoke`, { method: 'POST' }).catch(() => {});
    }
  }

  finish();
}

function finish() {
  const fails = results.filter((r) => !r.pass);
  console.log(`\n== P3-LIVE: ${results.length} graded cases, ${fails.length} FAIL ==`);
  if (fails.length) { console.log('FAILS:', fails.map((f) => f.id).join(', ')); process.exitCode = 1; }
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
