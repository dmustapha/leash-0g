// D2 (PHASE-2 spec §2b): coordinated governed action END-TO-END on the
// DEPLOYED stack — sentinel A senses + reasons on 0G Compute via its gateway
// and delegates; executor B receives, re-reasons on ITS gateway, validates
// against ITS on-chain policy, and acts through its LeashAccount session key.
// Lifecycle pending → accepted → completed with the real tx hash attached.
// Teardown: REVOKE PAIR via /api/agents/revoke-batch (guardian lane, D5).
//
// Usage: node scripts/deployed-pair-e2e.mjs   (reads backend/.env; real Privy SIWE)
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
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

const chain = {
  id: 16602,
  name: '0G-Galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [env.ZERO_G_RPC] } },
};
const pub = createPublicClient({ chain, transport: http(env.ZERO_G_RPC) });
const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY);
const opsWallet = createWalletClient({ account: ops, chain, transport: http(env.ZERO_G_RPC) });

const owner = privateKeyToAccount(generatePrivateKey());
const beneficiary = privateKeyToAccount(generatePrivateKey());
console.log('owner (throwaway):', owner.address);
console.log('beneficiary (throwaway):', beneficiary.address);

const PRIVY = 'https://auth.privy.io/api/v1';
const privyHeaders = { 'privy-app-id': env.PRIVY_APP_ID, 'content-type': 'application/json', origin: `https://${FE_DOMAIN}` };

async function privyLogin() {
  const initRes = await fetch(`${PRIVY}/siwe/init`, {
    method: 'POST', headers: privyHeaders, body: JSON.stringify({ address: owner.address }),
  });
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
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createAgent(name, goal, policy, allowlist) {
  const auditKey = new PrivateKey();
  const res = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      goal,
      policy,
      allowlist,
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'pair-e2e-throwaway' })).toString('base64'),
    }),
  });
  if (res.status !== 201) throw new Error(`create ${name} failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function main() {
  const evidence = {};

  // 0. wake ping (Render free tier cold start)
  let awake = false;
  for (let i = 0; i < 30 && !awake; i++) {
    const r = await fetch(`${API}/healthz`).catch(() => null);
    if (r?.ok) awake = true;
    else await sleep(6000);
  }
  if (!awake) throw new Error('backend did not wake');
  console.log('backend awake');
  token = await privyLogin();
  console.log('privy SIWE login OK');

  // 1. the PAIR: sentinel A (spend-incapable) + executor B
  const expiry = Math.floor(Date.now() / 1000) + 7200;
  const sentinel = await createAgent(
    'pair-e2e-sentinel',
    { type: 'sentinel', beneficiary: beneficiary.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.002').toString() },
    { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: expiry },
    [],
  );
  console.log('sentinel A:', sentinel.agentId, 'account', sentinel.accountAddr, '(zero caps, empty allowlist)');
  const executor = await createAgent(
    'pair-e2e-executor',
    { type: 'executor' },
    { perTransferCapWei: parseEther('0.003').toString(), windowCapWei: parseEther('0.009').toString(), windowSeconds: 3600, expiresAt: expiry },
    [beneficiary.address],
  );
  console.log('executor B:', executor.agentId, 'account', executor.accountAddr);
  evidence.sentinel = { agentId: sentinel.agentId, accountAddr: sentinel.accountAddr };
  evidence.executor = { agentId: executor.agentId, accountAddr: executor.accountAddr };

  // 2. fund the EXECUTOR's account (B acts with B's own funds); A gets nothing.
  const fundTx = await opsWallet.sendTransaction({ to: executor.accountAddr, value: parseEther('0.01') });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  evidence.fundTx = fundTx;
  console.log('executor account funded 0.01 0G');

  // 3. owner-authorized link A→B (auto mode: autonomy-by-default)
  const link = await api('/api/links', {
    method: 'POST',
    body: JSON.stringify({ fromAgentId: sentinel.agentId, toAgentId: executor.agentId, mode: 'auto' }),
  });
  if (link.status !== 201) throw new Error(`link failed ${link.status}: ${JSON.stringify(link.body)}`);
  evidence.linkId = link.body.link.id;
  console.log('link created:', link.body.link.id);

  // 4. start BOTH runtimes; watch the delegation lifecycle
  for (const id of [sentinel.agentId, executor.agentId]) {
    const start = await api(`/api/agents/${id}/start`, { method: 'POST', body: '{}' });
    if (start.status >= 300) throw new Error(`start ${id} failed: ${JSON.stringify(start.body)}`);
  }
  console.log('both runtimes started; waiting for delegate → accept → complete…');

  let completed = null;
  const seenStatuses = new Set();
  for (let i = 0; i < 60 && !completed; i++) {
    await sleep(8000);
    const feed = await api(`/api/delegations?linkId=${evidence.linkId}`);
    for (const d of feed.body.delegations ?? []) {
      seenStatuses.add(d.status);
      if (d.status === 'completed' && d.result?.txHash) completed = d;
    }
    if (i % 5 === 4) console.log(`  …statuses seen: ${[...seenStatuses].join(', ') || '(none yet)'}`);
  }
  if (!completed) throw new Error(`no completed delegation with tx; statuses seen: ${[...seenStatuses]}`);
  evidence.delegation = { id: completed.id, kind: completed.kind, status: completed.status, result: completed.result };
  console.log('DELEGATION COMPLETED:', completed.id, 'tx', completed.result.txHash);

  // 5. the act is REAL: beneficiary balance moved on-chain via B's LeashAccount
  const benBal = await pub.getBalance({ address: beneficiary.address });
  if (benBal === 0n) throw new Error('beneficiary balance still 0');
  const receipt = await pub.getTransactionReceipt({ hash: completed.result.txHash });
  if (receipt.status !== 'success') throw new Error('completed tx not successful on-chain');
  evidence.beneficiaryBalanceWei = benBal.toString();

  // 6. BOTH chains carry the coordination (D3 surface): A logs 'delegate',
  //    B logs 'delegation_update', same delegationId.
  const trA = await api(`/api/agents/${sentinel.agentId}/traces?limit=200`);
  const trB = await api(`/api/agents/${executor.agentId}/traces?limit=200`);
  const delegateRec = (trA.body.records ?? []).find((r) => r.kind === 'delegate');
  const updateRec = (trB.body.records ?? []).find(
    (r) => r.kind === 'delegation_update' && r.detail?.delegationId === completed.id,
  );
  if (delegateRec?.detail?.delegationId !== completed.id) throw new Error("sentinel chain missing 'delegate'");
  if (!updateRec) throw new Error("executor chain missing 'delegation_update'");
  if (trA.body.chainVerified !== true || trB.body.chainVerified !== true) throw new Error('a trace chain failed verification');
  evidence.correlation = { delegationId: completed.id, sentinelDelegateSeq: delegateRec.seq, executorUpdateSeq: updateRec.seq };
  console.log('both chains carry the exchange, same delegationId, chains verified');

  // 7. teardown: REVOKE PAIR in one action (D5) — both fail closed
  const batch = await api('/api/agents/revoke-batch', {
    method: 'POST',
    body: JSON.stringify({ agentIds: [sentinel.agentId, executor.agentId] }),
  });
  if (batch.status !== 200) throw new Error(`revoke-batch failed: ${JSON.stringify(batch.body)}`);
  for (const r of batch.body.results) {
    if (!r.ok) throw new Error(`pair revoke failed for ${r.agentId}: ${JSON.stringify(r)}`);
  }
  await sleep(6000);
  const revokedAbi = [{ name: 'revoked', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }];
  const [revA, revB] = await Promise.all(
    [sentinel.accountAddr, executor.accountAddr].map((a) =>
      pub.readContract({ address: a, abi: revokedAbi, functionName: 'revoked' }),
    ),
  );
  if (revA !== true || revB !== true) throw new Error('pair revoke incomplete on-chain');
  evidence.revokePair = { results: batch.body.results, revokedOnChain: { sentinel: revA, executor: revB } };
  console.log('PAIR REVOKED on-chain (both accounts fail closed)');

  console.log('\nDEPLOYED PAIR E2E (D2): PASS');
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => { console.error('DEPLOYED PAIR E2E (D2): FAIL —', e.message); process.exit(1); });
