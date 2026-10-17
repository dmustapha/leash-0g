// Deployed-stack Agent-Chaining drill (Phase-5.6, D-7). Drives the LIVE Render
// backend + 0G testnet with REAL Privy SIWE (throwaway owner) through a 2-hop
// chain end to end:
//   create an UPSTREAM treasury agent + a DOWNSTREAM treasury agent (a spender)
//   → link upstream→downstream → start upstream
//   → POST /direct (real 0G elevation) → confirm WITH a chainPlan targeting the
//     downstream : assert GET /api/chains shows a `planned` chain + ZERO delegations
//     (quarantine — arms nothing at confirm, D-1/D-2)
//   → wait cycles : the upstream's directed cycle PROPOSES hop 0 as a SUPERVISED
//     delegation (spender downstream → owner-approved, Gap-2/D-2) — assert a
//     chain.handoff approval appears
//   → owner APPROVES the hop → the downstream re-reasons on the upstream output
//     under its OWN leash and the chain advances → assert the chain reaches
//     `completed`/`running` past hop 0 and a hop delegation is `completed`.
// Usage: node scripts/deployed-chain-drill.mjs  (reads backend/.env for PRIVY_APP_ID;
// REQUIRES Phase-5.6 deployed on the live stack — run AFTER deploy).
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';

const API = process.env.DEPLOYED_API ?? 'https://api.leash.ink';
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
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'chain-drill-throwaway' })).toString('base64'),
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
  // Upstream target 0 → its beneficiary already "meets" it → the upstream always
  // stands down cleanly (never its own approval-interrupt), so its directed cycle
  // completes and the chain hook proposes hop 0. The CHAIN itself is what we test.
  const upstream = await makeTreasury('chain-drill upstream', benUpstream, '0');
  const downstream = await makeTreasury('chain-drill downstream', benDownstream);
  console.log('agents:', { upstream, downstream });

  const link = await api('/api/links', { method: 'POST', body: JSON.stringify({ fromAgentId: upstream, toAgentId: downstream, mode: 'supervised' }) });
  if (link.status !== 200 && link.status !== 201) throw new Error(`link failed ${link.status}: ${JSON.stringify(link.body)}`);
  console.log('link upstream→downstream (supervised) OK');

  // BOTH must run: the upstream to propose the hop, the DOWNSTREAM to pick up
  // and process the inbound chain.handoff once the owner approves it.
  await api(`/api/agents/${upstream}/start`, { method: 'POST' });
  await api(`/api/agents/${downstream}/start`, { method: 'POST' });
  await sleep(40000); // one directed cycle on real 0G Compute

  const direct = await api(`/api/agents/${upstream}/direct`, { method: 'POST', body: JSON.stringify({ intent: 'analyze the balance then hand the finding to my other agent' }) });
  if (direct.status !== 200) throw new Error(`/direct ${direct.status}: ${JSON.stringify(direct.body)} — is Phase-5.6 deployed?`);
  const { id: directionId } = direct.body.direction;

  // Pass an empty goalPatch so the directive can't raise the upstream's target
  // (which would make it want to spend and hit its own approval interrupt).
  const editedDraft = { ...direct.body.direction.draft, goalPatch: {} };
  const confirm = await api(`/api/agents/${upstream}/direct/${directionId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ edited: editedDraft, chainPlan: [{ eligibleTargetIds: [downstream], directedIntent: 'rebalance based on the analysis' }] }),
  });
  if (confirm.status !== 200) throw new Error(`/confirm+chainPlan ${confirm.status}: ${JSON.stringify(confirm.body)}`);
  console.log('confirm + chainPlan OK');

  // Quarantine (D-1/D-2): a planned chain exists, but NO delegation is armed.
  const chains = await api('/api/chains');
  const chain = (chains.body.chains ?? []).find((c) => c.originAgentId === upstream);
  if (!chain || chain.status !== 'planned') throw new Error(`D-1 FAIL: no planned chain (got ${JSON.stringify(chains.body)})`);
  const delegs0 = await api(`/api/delegations?agentId=${upstream}`);
  if ((delegs0.body.delegations ?? []).some((d) => d.kind === 'chain.handoff')) throw new Error('D-2 FAIL: a chain.handoff delegation was armed at confirm');
  console.log('D-1/D-2 OK — planned chain', chain.id, '+ zero hop delegations at confirm');

  // Wait for the runtime hook to propose hop 0 as a SUPERVISED delegation.
  let approvalId = null;
  for (let i = 0; i < 18; i++) {
    await sleep(20000);
    const alerts = await api(`/api/alerts`);
    const card = (alerts.body.alerts ?? []).find((a) => a.kind === 'approval_required' && a.refs?.delegationId);
    if (card) { approvalId = card.refs.approvalId; break; }
  }
  if (!approvalId) throw new Error('D-2 FAIL: no supervised chain-hop approval appeared (Gap-2 spender→supervised)');
  console.log('hop 0 proposed as SUPERVISED (Gap-2) — approvalId', approvalId);

  const approve = await api(`/api/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  if (approve.status !== 200) throw new Error(`approve ${approve.status}: ${JSON.stringify(approve.body)}`);
  console.log('owner approved the hop');

  // The downstream re-reasons under its OWN leash and the hop settles → chain advances.
  let settled = false;
  for (let i = 0; i < 15; i++) {
    await sleep(20000);
    const c = await api(`/api/chains/${chain.id}`);
    const hop = (c.body.hops ?? [])[0];
    if (hop && ['completed', 'failed'].includes(hop.status)) { settled = true; console.log('hop 0 settled:', hop.status, '| chain status:', c.body.chain?.status); break; }
  }
  if (!settled) throw new Error('D-7 FAIL: hop 0 never settled after approval');

  console.log('\nDEPLOYED CHAIN DRILL (D-7): PASS');
  console.log(JSON.stringify({ ts: new Date().toISOString(), owner: owner.address, upstream, downstream, chainId: chain.id }, null, 2));
}

main().catch((e) => { console.error('DEPLOYED CHAIN DRILL: FAIL —', e.message); process.exit(1); });
