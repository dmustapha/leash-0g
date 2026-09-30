// SE-7 (E-8) — SE-3 WIND-DOWN-MID-CHAIN live spot-check on the DEPLOYED stack.
// Forks the Phase-5.6 chain drill up to the MID-CHAIN point (chain running, hop 0
// proposed as a SUPERVISED delegation, owner has NOT approved), then instead of
// approving:
//   → POST /api/agents/:upstream/wind-down (the owner winds the origin down)
//   → assert the chain is TERMINATED (D-4 "wind-down fails safe")
//   → assert the in-flight chain.handoff delegation is CANCELLED
//   → ADVERSARIAL: approving the now-stale hop approval afterwards must NOT
//     resurrect the chain (stays terminated; delegation stays cancelled)
//   → restart the upstream: the chain must NOT resume (terminated is terminal).
// Usage: node scripts/deployed-winddown-drill.mjs   (reads backend/.env; live stack)
// Evidence → docs/evidence/stage-e-winddown-drill.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';

const API = process.env.DEPLOYED_API ?? 'https://leash-0g-backend.onrender.com';
const FE_DOMAIN = 'leash-0g-web.vercel.app';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1);
  }
}

const owner = privateKeyToAccount(generatePrivateKey());
console.log('owner (throwaway):', owner.address);
const PRIVY = 'https://auth.privy.io/api/v1';
const privyHeaders = { 'privy-app-id': env.PRIVY_APP_ID, 'content-type': 'application/json', origin: `https://${FE_DOMAIN}` };

async function privyLogin() {
  const initRes = await fetch(`${PRIVY}/siwe/init`, { method: 'POST', headers: privyHeaders, body: JSON.stringify({ address: owner.address }) });
  if (!initRes.ok) throw new Error(`siwe/init ${initRes.status}: ${await initRes.text()}`);
  const { nonce } = await initRes.json();
  const issuedAt = new Date().toISOString();
  const message = `${FE_DOMAIN} wants you to sign in with your Ethereum account:\n${owner.address}\n\nBy signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.\n\nURI: https://${FE_DOMAIN}\nVersion: 1\nChain ID: 16602\nNonce: ${nonce}\nIssued At: ${issuedAt}\nResources:\n- https://privy.io`;
  const signature = await owner.signMessage({ message });
  const authRes = await fetch(`${PRIVY}/siwe/authenticate`, {
    method: 'POST', headers: privyHeaders,
    body: JSON.stringify({ message, signature, walletClientType: 'rainbow', connectorType: 'injected', mode: 'login-or-sign-up' }),
  });
  if (!authRes.ok) throw new Error(`siwe/authenticate ${authRes.status}: ${await authRes.text()}`);
  return (await authRes.json()).token;
}

let token;
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeTreasury(name, beneficiary, targetBalanceWei = '2000000000000000000') {
  const auditKey = new PrivateKey();
  const create = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      goal: { type: 'treasury', beneficiary, targetBalanceWei, topUpWei: '100000000000000' },
      policy: { perTransferCapWei: '1000000000000000', windowCapWei: '5000000000000000', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
      allowlist: [beneficiary],
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'winddown-drill-throwaway' })).toString('base64'),
    }),
  });
  if (create.status !== 201 && create.status !== 200) throw new Error(`create ${name} failed ${create.status}: ${JSON.stringify(create.body)}`);
  return create.body.agentId;
}

async function main() {
  for (let i = 0; i < 12; i++) { const r = await fetch(`${API}/healthz`).catch(() => null); if (r?.ok) break; await sleep(6000); }
  token = await privyLogin();
  console.log('privy SIWE login OK');

  const benUpstream = privateKeyToAccount(generatePrivateKey()).address;
  const benDownstream = privateKeyToAccount(generatePrivateKey()).address;
  const upstream = await makeTreasury('winddown-drill upstream', benUpstream, '0');
  const downstream = await makeTreasury('winddown-drill downstream', benDownstream);
  console.log('agents:', { upstream, downstream });

  const link = await api('/api/links', { method: 'POST', body: JSON.stringify({ fromAgentId: upstream, toAgentId: downstream, mode: 'supervised' }) });
  if (link.status !== 200 && link.status !== 201) throw new Error(`link failed ${link.status}: ${JSON.stringify(link.body)}`);

  await api(`/api/agents/${upstream}/start`, { method: 'POST' });
  await api(`/api/agents/${downstream}/start`, { method: 'POST' });
  await sleep(40000);

  const direct = await api(`/api/agents/${upstream}/direct`, { method: 'POST', body: JSON.stringify({ intent: 'analyze the balance then hand the finding to my other agent' }) });
  if (direct.status !== 200) throw new Error(`/direct ${direct.status}: ${JSON.stringify(direct.body)}`);
  const { id: directionId } = direct.body.direction;
  const editedDraft = { ...direct.body.direction.draft, goalPatch: {} };
  const confirm = await api(`/api/agents/${upstream}/direct/${directionId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ edited: editedDraft, chainPlan: [{ eligibleTargetIds: [downstream], directedIntent: 'rebalance based on the analysis' }] }),
  });
  if (confirm.status !== 200) throw new Error(`/confirm+chainPlan ${confirm.status}: ${JSON.stringify(confirm.body)}`);
  console.log('confirm + chainPlan OK');

  const chains = await api('/api/chains');
  const chain = (chains.body.chains ?? []).find((c) => c.originAgentId === upstream);
  if (!chain) throw new Error(`no chain found for origin ${upstream}`);
  console.log('chain planned:', chain.id);

  // Wait until MID-CHAIN: hop 0 proposed as a SUPERVISED delegation (in flight,
  // NOT approved). This is the point the spot-check winds down at.
  let approvalId = null;
  for (let i = 0; i < 18; i++) {
    await sleep(20000);
    const alerts = await api(`/api/alerts`);
    const card = (alerts.body.alerts ?? []).find((a) => a.kind === 'approval_required' && a.refs?.delegationId);
    if (card) { approvalId = card.refs.approvalId; break; }
  }
  if (!approvalId) throw new Error('mid-chain point never reached: no supervised hop approval appeared');
  console.log('MID-CHAIN: hop 0 in flight (supervised, unapproved) — approvalId', approvalId);

  // ── THE SPOT-CHECK: owner winds the ORIGIN down mid-chain ───────────────────
  const wd = await api(`/api/agents/${upstream}/wind-down`, { method: 'POST' });
  if (wd.status !== 200) throw new Error(`wind-down ${wd.status}: ${JSON.stringify(wd.body)}`);
  console.log('wind-down accepted');

  // 1. the chain is TERMINATED
  let terminated = false, chainStatus = null;
  for (let i = 0; i < 6; i++) {
    const c = await api(`/api/chains/${chain.id}`);
    chainStatus = c.body.chain?.status;
    if (chainStatus === 'terminated') { terminated = true; break; }
    await sleep(5000);
  }
  if (!terminated) throw new Error(`E-8 FAIL: chain status is '${chainStatus}', want 'terminated'`);
  console.log('PASS 1: chain terminated');

  // 2. the in-flight hop delegation is CANCELLED
  const delegs = await api(`/api/delegations?agentId=${upstream}`);
  const hopDeleg = (delegs.body.delegations ?? []).find((d) => d.kind === 'chain.handoff');
  if (!hopDeleg) throw new Error('E-8 FAIL: no chain.handoff delegation found');
  if (hopDeleg.status !== 'cancelled') throw new Error(`E-8 FAIL: hop delegation status '${hopDeleg.status}', want 'cancelled'`);
  console.log('PASS 2: in-flight hop delegation cancelled');

  // 3. ADVERSARIAL: approving the stale hop AFTER wind-down must not resurrect it
  const staleApprove = await api(`/api/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  await sleep(10000);
  const after = await api(`/api/chains/${chain.id}`);
  const delegsAfter = await api(`/api/delegations?agentId=${upstream}`);
  const hopAfter = (delegsAfter.body.delegations ?? []).find((d) => d.kind === 'chain.handoff');
  if (after.body.chain?.status !== 'terminated') throw new Error(`E-8 FAIL: stale approve resurrected the chain (status ${after.body.chain?.status})`);
  if (hopAfter?.status !== 'cancelled') throw new Error(`E-8 FAIL: stale approve resurrected the hop (status ${hopAfter?.status})`);
  console.log(`PASS 3: stale approve (HTTP ${staleApprove.status}) did NOT resurrect — chain terminated, hop cancelled`);

  // 4. restart the origin: the terminated chain must NOT resume
  await api(`/api/agents/${upstream}/start`, { method: 'POST' });
  await sleep(45000);
  const resumed = await api(`/api/chains/${chain.id}`);
  if (resumed.body.chain?.status !== 'terminated') throw new Error(`E-8 FAIL: chain resumed after restart (status ${resumed.body.chain?.status})`);
  console.log('PASS 4: restart did not resume the terminated chain');

  const evidence = {
    phase: 'Stage E — SE-7 (E-8): SE-3 wind-down-mid-chain live spot-check',
    api: API,
    ts: new Date().toISOString(),
    owner: owner.address,
    upstream, downstream,
    chainId: chain.id,
    approvalId,
    checks: {
      chainTerminated: true,
      inFlightHopCancelled: true,
      staleApproveDidNotResurrect: true,
      restartDidNotResume: true,
    },
    staleApproveHttpStatus: staleApprove.status,
  };
  mkdirSync(new URL('../../docs/evidence/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../../docs/evidence/stage-e-winddown-drill.json', import.meta.url), JSON.stringify(evidence, null, 2));
  console.log('\nDEPLOYED WIND-DOWN DRILL (E-8): PASS — evidence → docs/evidence/stage-e-winddown-drill.json');
}

main().catch((e) => { console.error('DEPLOYED WIND-DOWN DRILL: FAIL —', e.message); process.exit(1); });
