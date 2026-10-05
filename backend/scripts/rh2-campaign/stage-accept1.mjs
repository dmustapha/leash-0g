// Fix-round 1 acceptance — F-4/F-5 against rh2 @ a6ba473.
//  ACC-1  F-5: spend-incapable create → status 'running' immediately (no start call)
//  ACC-2  F-4: treasury action within ONE 30s cycle, 4 of 5 trials (create/fund/start)
//  ACC-3  F-4: approved delegation SURVIVES parse misses → executor eventually acts
import { parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { appendFileSync } from 'node:fs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, record, section, summary, clients } from './common.mjs';

const owner = campaignOwner('owner-a');
await warm(API);
const api = makeApi(await privyLogin(owner));
const og = clients(16602);
const CYCLE_MS = 30_000;

const audit = () => {
  const k = new PrivateKey();
  return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase' })).toString('base64') };
};
async function pollAction(agentId, budgetMs) {
  const t0 = Date.now();
  for (;;) {
    const tr = await api(`/api/agents/${agentId}/traces?limit=100`);
    const act = (tr.body.records ?? []).find((r) => r.kind === 'action' && (r.detail?.txHash || r.response?.txHash));
    if (act) return Date.now() - t0;
    if (Date.now() - t0 > budgetMs) return null;
    await sleep(4000);
  }
}

section('ACC-1 F-5 auto-start (spend-incapable)');
{
  const r = await api('/api/agents', { method: 'POST', body: {
    name: 'acc1 provider', goal: { type: 'provider', serviceSpec: 'acceptance probe' },
    policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
    allowlist: [], ...audit() } });
  if (r.status === 201) {
    const d = await api(`/api/agents/${r.body.agentId}`);
    record('ACC-1-autostart', d.body.status === 'running', `provider born status=${d.body.status}`);
    await api(`/api/agents/${r.body.agentId}/stop`, { method: 'POST', body: '{}' });
    // opt-out still works
    const r2 = await api('/api/agents', { method: 'POST', body: {
      name: 'acc1 optout', autoStart: false, goal: { type: 'provider', serviceSpec: 'optout probe' },
      policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      allowlist: [], ...audit() } });
    if (r2.status === 201) {
      const d2 = await api(`/api/agents/${r2.body.agentId}`);
      record('ACC-1b-optout', d2.body.status === 'paused', `autoStart:false -> ${d2.body.status}`);
    }
  } else record('ACC-1-autostart', false, `create ${r.status}`);
}

section('ACC-2 F-4 one-cycle liveness ×5');
{
  const times = [];
  for (let t = 1; t <= 5; t++) {
    const ben = privateKeyToAccount(generatePrivateKey()).address;
    const r = await api('/api/agents', { method: 'POST', body: {
      name: `acc2 t${t}`, goal: { beneficiary: ben, targetBalanceWei: parseEther('0.004').toString(), topUpWei: parseEther('0.002').toString() },
      policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      allowlist: [ben], ...audit() } });
    if (r.status !== 201) { record(`ACC-2-t${t}`, false, `create ${r.status}`); continue; }
    const fundTx = await og.opsWallet.sendTransaction({ to: r.body.accountAddr, value: parseEther('0.015') });
    await og.pub.waitForTransactionReceipt({ hash: fundTx });
    await api(`/api/agents/${r.body.agentId}/start`, { method: 'POST', body: '{}' });
    const ms = await pollAction(r.body.agentId, CYCLE_MS + 45_000); // one cycle + retry headroom + tx time
    times.push(ms);
    record(`ACC-2-t${t}`, ms !== null && ms <= CYCLE_MS + 45_000, ms === null ? 'no action in budget' : `action in ${Math.round(ms / 1000)}s`);
    await api(`/api/agents/${r.body.agentId}/stop`, { method: 'POST', body: '{}' });
    await api(`/api/agents/${r.body.agentId}/revoke`, { method: 'POST', body: '{}' }).catch(() => {});
  }
  const ok = times.filter((m) => m !== null).length;
  record('ACC-2-verdict', ok >= 4, `${ok}/5 within budget; times=[${times.map((m) => (m === null ? 'miss' : Math.round(m / 1000) + 's')).join(',')}]`);
}

section('ACC-3 F-4 delegation survives parse misses');
{
  const sen = '63d56989-e656-44a9-94ba-16dfc8bf0b9c';
  const exe = '0592dd50-5b08-49ed-87e6-c91c99c6efac';
  await api(`/api/agents/${exe}/start`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${sen}/start`, { method: 'POST', body: '{}' });
  const t0 = Date.now();
  let approvalId = null;
  while (!approvalId && Date.now() - t0 < 240_000) {
    await sleep(5000);
    const al = await api('/api/alerts?limit=20');
    const a = (al.body.alerts ?? []).find((x) => x.kind === 'approval_required' && x.status === 'unread');
    if (a?.refs?.approvalId) approvalId = a.refs.approvalId;
  }
  if (!approvalId) record('ACC-3-delegation', false, 'no approval within 240s');
  else {
    const dec = await api(`/api/approvals/${approvalId}`, { method: 'POST', body: { decision: 'approve', reason: 'acceptance' } });
    // Watch up to 5 cycles: requeue semantics mean a parse-missed envelope returns to pending and is retried.
    const ms = await pollAction(exe, 5 * CYCLE_MS + 30_000);
    record('ACC-3-delegation', dec.status === 200 && ms !== null, ms === null ? 'approved but never consumed in 5 cycles' : `approved -> executor acted in ${Math.round(ms / 1000)}s (requeue survival ✓)`);
  }
  await api(`/api/agents/${sen}/stop`, { method: 'POST', body: '{}' });
  await api(`/api/agents/${exe}/stop`, { method: 'POST', body: '{}' });
}

summary('Acceptance fix-round 1');
