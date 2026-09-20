// Deployed-stack E2E (D10): drives the LIVE Render backend + 0G testnet through
// the Phase-1 happy path with REAL Privy auth (headless SIWE, throwaway owner).
//   create → watch (real 0G Compute reasoning traces) → act (real on-chain
//   transfer via LeashAccount) → revoke (guardian) → fail-closed proof.
// Usage: node scripts/deployed-e2e.mjs   (reads backend/.env for PRIVY_APP_ID,
// ops key to fund the account, RPC; owner wallet is generated fresh each run)
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
const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY.startsWith('0x') ? env.OPS_PRIVATE_KEY : `0x${env.OPS_PRIVATE_KEY}`);
const opsWallet = createWalletClient({ account: ops, chain, transport: http(env.ZERO_G_RPC) });

const owner = privateKeyToAccount(generatePrivateKey());
const beneficiary = privateKeyToAccount(generatePrivateKey());
console.log('owner (throwaway):', owner.address);
console.log('beneficiary (throwaway):', beneficiary.address);

// ---------- 1. Headless SIWE login → real Privy access token ----------
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
  const auth = await authRes.json();
  return auth.token;
}

// ---------- helpers ----------
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

async function main() {
  // warm the free-tier instance
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${API}/healthz`).catch(() => null);
    if (r?.ok) break;
    await sleep(6000);
  }
  console.log('backend healthy');

  token = await privyLogin();
  console.log('privy SIWE login OK (real access token)');

  // ---------- 2. CREATE (backend deploys LeashAccount via factory on-chain) ----------
  const auditKey = new PrivateKey();
  const create = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'deployed-e2e-agent',
      goal: { beneficiary: beneficiary.address, targetBalanceWei: parseEther('0.008').toString(), topUpWei: parseEther('0.004').toString() },
      policy: {
        perTransferCapWei: parseEther('0.005').toString(),
        windowCapWei: parseEther('0.015').toString(),
        windowSeconds: 3600,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
      allowlist: [beneficiary.address],
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'e2e-throwaway' })).toString('base64'),
    }),
  });
  if (create.status !== 201 && create.status !== 200) throw new Error(`create failed ${create.status}: ${JSON.stringify(create.body)}`);
  const { agentId, accountAddr, txHashes } = create.body;
  console.log('created agent', agentId, 'account', accountAddr, 'txs', txHashes);

  // ---------- 3. fund the account so the agent can act ----------
  const fundTx = await opsWallet.sendTransaction({ to: accountAddr, value: parseEther('0.02') });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  console.log('account funded 0.02 0G:', fundTx);

  // ---------- 4. START → watch for real reasoning + on-chain action ----------
  const start = await api(`/api/agents/${agentId}/start`, { method: 'POST', body: '{}' });
  if (start.status >= 300) throw new Error(`start failed ${start.status}: ${JSON.stringify(start.body)}`);
  console.log('runtime started; polling traces for inference + action…');

  let actionTx = null; let sawInference = false;
  for (let i = 0; i < 40 && !actionTx; i++) {
    await sleep(8000);
    const tr = await api(`/api/agents/${agentId}/traces?limit=200`);
    const records = tr.body.records ?? [];
    sawInference = sawInference || records.some((r) => r.kind === 'inference');
    const act = records.find((r) => r.kind === 'action' && (r.detail?.txHash || r.response?.txHash));
    if (act) actionTx = act.detail?.txHash ?? act.response?.txHash;
    if (i % 4 === 3) console.log(`  …${records.length} records, inference=${sawInference}, chainVerified=${tr.body.chainVerified}`);
  }
  if (!sawInference) throw new Error('no inference trace appeared — reasoning did not run');
  if (!actionTx) throw new Error('no on-chain action trace appeared');
  const benBal = await pub.getBalance({ address: beneficiary.address });
  console.log('ACTION on-chain tx:', actionTx, '| beneficiary balance:', benBal.toString());
  if (benBal === 0n) throw new Error('beneficiary balance still 0 — action did not move funds');

  // ---------- 5. REVOKE (guardian path) → fail-closed everywhere ----------
  const rev = await api(`/api/agents/${agentId}/revoke`, { method: 'POST', body: '{}' });
  if (rev.status >= 300) throw new Error(`revoke failed ${rev.status}: ${JSON.stringify(rev.body)}`);
  await sleep(6000);
  const detail = await api(`/api/agents/${agentId}`);
  const revokedOnChain = await pub.readContract({
    address: accountAddr,
    abi: [{ name: 'revoked', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }],
    functionName: 'revoked',
  });
  console.log('status after revoke:', detail.body.status, '| on-chain revoked():', revokedOnChain);
  if (detail.body.status !== 'revoked' || revokedOnChain !== true) throw new Error('revoke fan-out incomplete');

  // ---------- 6. audit batches (best-effort — flush is async, T=60s) ----------
  await sleep(65000);
  const audit = await api(`/api/agents/${agentId}/audit`);
  console.log('audit batches:', (audit.body.batches ?? audit.body ?? []).length ?? 0);

  console.log('\nDEPLOYED-STACK E2E: PASS');
  console.log(JSON.stringify({ agentId, accountAddr, fundTx, actionTx, revokedOnChain, owner: owner.address, beneficiary: beneficiary.address }, null, 2));
}

main().catch((e) => { console.error('DEPLOYED-STACK E2E: FAIL —', e.message); process.exit(1); });
