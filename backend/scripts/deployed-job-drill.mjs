// Phase-4 deployed drill D-JOB-10 (spec §8 "Deployed" row) — the FULL ACP job
// loop on the AS-DEPLOYED stack (Render + real Privy SIWE + the REAL Telegram
// bot + 0G Galileo chain 16602 + v3 token-capable factory + TestUSD):
//
//   requester originates an owner-seeded job → provider reasons (0G Compute) +
//   delivers (0G Storage) → evaluator skeptic verdict → deterministic acceptance
//   floor → owner approval interrupt (pushed to the phone, verdict-bound) →
//   INLINE APPROVE tapped on a real phone → governed executeTokenTransfer (REAL
//   ERC-20 settlement of the job fee) → multi-party PoA on the owner/audit stream.
//
// The settlement is a governed ERC-20 transfer of the fee (server-state amount,
// F4) from the requester's v3 LeashAccount — NOT a native 0G send. Its trace is
// labelled category:'jobFee' (§8) so the digest reports it distinctly.
//
// INTERACTIVE: the operator (Dami) taps the Telegram link + APPROVE on their
// phone when prompted. Evidence JSON (untruncated hashes) printed at the end.
//
// PREREQUISITES (external — see docs/runbooks/D-JOB-10.md):
//   1. Render backend redeployed on the Phase-4 branch with env
//      LEASH_FACTORY_ADDR = the v3 factory (0xcD78…8105) and the bot configured.
//   2. The ops key funds gas; TestUSD is minted to the requester account here.
//
// Usage: node scripts/deployed-job-drill.mjs        (reads backend/.env)
//   env: DEPLOYED_API (default Render), SETTLEMENT_TOKEN (default TestUSD v3),
//        LEASH_FACTORY_V3 (informational; the backend's own env is authoritative)
import { readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseEther, encodeFunctionData } from 'viem';
import { PrivateKey } from 'eciesjs';

const API = process.env.DEPLOYED_API ?? 'https://leash-0g-backend.onrender.com';
const FE_DOMAIN = 'leash-0g-web.vercel.app';
// Deployed 2026-09-23 (docs/DEPLOYMENTS.md → v3 redeploy). The backend's own
// LEASH_FACTORY_ADDR is authoritative for account creation; this is the token.
const TEST_USD = (process.env.SETTLEMENT_TOKEN ?? '0xbeeA96c7614ebc46760B442068E359e51e7c4e52').toLowerCase();

// H-02: this script signs REAL value transfers with the ops key (mint TestUSD +
// native gas). Pin the API host and settlement token to known-good values so a
// poisoned env can't redirect the ops key's funds to an attacker contract or
// address. `--i-understand-override` is required to point elsewhere.
const OVERRIDE = process.argv.includes('--i-understand-override');
const ALLOWED_API_HOSTS = ['leash-0g-backend.onrender.com'];
const KNOWN_TEST_USD = '0xbeea96c7614ebc46760b442068e359e51e7c4e52';
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
if (!OVERRIDE) {
  const host = new URL(API).host;
  if (!ALLOWED_API_HOSTS.includes(host)) throw new Error(`refusing unpinned DEPLOYED_API host '${host}' (pass --i-understand-override to allow)`);
  if (TEST_USD !== KNOWN_TEST_USD) throw new Error(`refusing unpinned SETTLEMENT_TOKEN '${TEST_USD}' (pass --i-understand-override to allow)`);
}
if (!isAddress(TEST_USD)) throw new Error(`SETTLEMENT_TOKEN is not an address: ${TEST_USD}`);

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
const feeRecipient = privateKeyToAccount(generatePrivateKey());
console.log('owner (throwaway):', owner.address);
console.log('fee recipient (throwaway):', feeRecipient.address);
console.log('settlement token (TestUSD):', TEST_USD);

const ERC20_ABI = [
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

// ---------- Privy headless SIWE (same flow the FE uses) ----------
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The drill polls for minutes across a free-tier host + a phone-paced approval.
// A transient network drop ('fetch failed') must NOT kill the run — retry the
// bare fetch a few times with backoff before surfacing the error.
async function resilientFetch(url, init, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await sleep(3_000 * (i + 1));
    }
  }
  throw lastErr;
}

let token;
async function api(path, opts = {}, _retried = false) {
  const res = await resilientFetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  // Privy SIWE tokens are ~1 h; a patient approval window outlives them. 401 =
  // "expired", not "denied" — re-login ONCE and retry (drill-7/8 root cause).
  if (res.status === 401 && !_retried) {
    token = await privyLogin();
    return api(path, opts, true);
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 });
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(4_000);
    }
  }
  throw new Error(`waitReceipt: exhausted ${tries} tries for ${hash}`);
}

async function waitUntil(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(5000);
  }
}

async function jobsList() {
  return (await api('/api/jobs')).body.jobs ?? [];
}

// Provider/evaluator are spend-incapable (zero native caps). Requester is the
// sole governed spender (token config, F1). Shared expiry window.
const EXPIRES = Math.floor(Date.now() / 1000) + 7200;
function spendIncapablePolicy() {
  return { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: EXPIRES };
}
function createRole(name, goal, extra = {}) {
  const auditKey = new PrivateKey();
  return {
    name,
    goal,
    policy: extra.policy ?? spendIncapablePolicy(),
    allowlist: extra.allowlist ?? [],
    gatewayRules: [],
    auditPubKey: auditKey.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'd-job-10-throwaway' })).toString('base64'),
    ...(extra.tokenConfig ? { tokenConfig: extra.tokenConfig } : {}),
  };
}

async function createAgent(body) {
  const r = await api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`create ${body.name} failed ${r.status}: ${JSON.stringify(r.body)}`);
  return { agentId: r.body.agentId, accountAddr: r.body.accountAddr };
}

async function link(fromAgentId, toAgentId) {
  const r = await api('/api/links', { method: 'POST', body: JSON.stringify({ fromAgentId, toAgentId, mode: 'auto' }) });
  if (r.status !== 201 && r.status !== 409) throw new Error(`link ${fromAgentId}->${toAgentId} failed ${r.status}: ${JSON.stringify(r.body)}`);
}

async function main() {
  const evidence = { drill: 'D-JOB-10', api: API, settlementToken: TEST_USD, generatedAt: new Date().toISOString() };

  // ---------- 0. wake + login ----------
  await waitUntil('backend awake', 180_000, async () => (await fetch(`${API}/healthz`).catch(() => null))?.ok);
  console.log('backend awake');
  token = await privyLogin();
  console.log('privy SIWE login OK');

  // ---------- 1. Telegram link (interactive) ----------
  let linked = false;
  for (let round = 0; round < 60 && !linked; round++) {
    const l = await api('/api/owner/telegram/link', { method: 'POST', body: '{}' });
    if (l.status !== 200) throw new Error(`telegram link failed ${l.status}: ${JSON.stringify(l.body)} — bot configured on Render?`);
    console.log('\n=== ACTION REQUIRED (phone) ===');
    console.log('Open in Telegram and tap START (fresh link, valid 5 min):');
    console.log('  ' + l.body.url);
    console.log('===============================\n');
    linked = await waitUntil('telegram linked', 240_000, async () => (await api('/api/owner/settings')).body.telegramLinked).catch(() => false);
  }
  if (!linked) throw new Error('timed out waiting for: telegram linked');
  evidence.telegramLinked = true;
  console.log('telegram linked ✓');

  // ---------- 2. Seed the owner-defined job spec (F5: fee + acceptance in server state) ----------
  const SPEC_REF = 'eth-4000-deployed';
  const FEE = (2n * 10n ** 6n).toString(); // 2 TestUSD (6dp) — the settled amount, from server state (F4)
  const jobSpec = {
    spec: { question: 'Will ETH close above $4000 this month?', deliverableSchemaRef: 'market-probability@v1', acceptanceRef: 'market-analysis-floor' },
    acceptance: {
      label: 'market-analysis-floor',
      rules: [
        { kind: 'required', path: 'probability' },
        { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
        { kind: 'required', path: 'rationale' },
        { kind: 'stringLength', path: 'rationale', min: 1 },
      ],
    },
    feeAmountWei: FEE,
  };
  const putSpec = await api(`/api/job-specs/${SPEC_REF}`, { method: 'PUT', body: JSON.stringify(jobSpec) });
  if (putSpec.status !== 200 && putSpec.status !== 201) throw new Error(`put job-spec failed ${putSpec.status}: ${JSON.stringify(putSpec.body)}`);
  evidence.jobSpecRef = SPEC_REF;
  console.log('job spec seeded ✓');

  // ---------- 3. Create the ACP triangle (provider + evaluator, then requester) ----------
  const provider = await createAgent(createRole('d-job-10-provider', { type: 'provider', serviceSpec: 'market probability analysis' }));
  const evaluator = await createAgent(createRole('d-job-10-evaluator', { type: 'evaluator', rubricRef: 'strict-calibration' }));
  const perTransferCapToken = (10n * 10n ** 6n).toString(); // 10 TestUSD per-transfer cap
  const requester = await createAgent(createRole(
    'd-job-10-requester',
    {
      type: 'requester',
      jobSpecSource: SPEC_REF,
      providerAgentId: provider.agentId,
      evaluatorAgentId: evaluator.agentId,
      feeToken: TEST_USD,
      feeRecipient: feeRecipient.address,
      feeCapPerJobWei: (5n * 10n ** 6n).toString(), // ≤ perTransferCapToken (F4)
    },
    {
      allowlist: [feeRecipient.address],
      tokenConfig: { settlementToken: TEST_USD, perTransferCapTokenWei: perTransferCapToken, windowCapTokenWei: (20n * 10n ** 6n).toString() },
    },
  ));
  evidence.agents = { requester, provider, evaluator };
  console.log('triangle created — requester account:', requester.accountAddr);

  // F6 hub topology: requester↔provider, requester↔evaluator (no provider↔evaluator).
  await link(requester.agentId, provider.agentId);
  await link(provider.agentId, requester.agentId);
  await link(requester.agentId, evaluator.agentId);
  await link(evaluator.agentId, requester.agentId);
  console.log('links wired (F6 hub) ✓');

  // ---------- 4. Fund: mint TestUSD to the requester account + gas dust ----------
  // H-02: the account address comes from the API — validate its shape before the
  // ops key sends any native value to it.
  if (!isAddress(requester.accountAddr)) throw new Error(`requester.accountAddr is not an address: ${requester.accountAddr}`);
  const mintData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'mint', args: [requester.accountAddr, 50n * 10n ** 6n] });
  const mintTx = await opsWallet.sendTransaction({ to: TEST_USD, data: mintData });
  await waitReceipt(mintTx);
  const bal = await pub.readContract({ address: TEST_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [requester.accountAddr] });
  if (bal < BigInt(FEE)) throw new Error(`TestUSD mint did not land: balance ${bal}`);
  // native gas so the session key can broadcast the settlement (backend sweeps dust)
  const gasTx = await opsWallet.sendTransaction({ to: requester.accountAddr, value: parseEther('0.01') });
  await waitReceipt(gasTx);
  evidence.funding = { mintTx, testUsdBalance: bal.toString(), gasTx };
  console.log(`funded ✓ requester holds ${bal} TestUSD base-units, mint tx ${mintTx}`);

  // ---------- 5. Start the triangle → the loop runs to the owner approval interrupt ----------
  for (const a of [provider, evaluator, requester]) {
    await api(`/api/agents/${a.agentId}/start`, { method: 'POST', body: '{}' });
  }
  console.log('all three started — the requester will originate, the loop runs, and a settlement approval should push to your phone.');

  // The job reaches `awaiting_approval` ONLY after the deterministic floor AND
  // the evaluator verdict passed (the layered gate, D-JOB-3). The verdict-bound
  // settlement approval is pushed to the phone (the script never approves — the
  // phone does, so no approvalId is needed here).
  const awaiting = await waitUntil('job awaiting_approval (floor + verdict passed)', 3_600_000, async () => {
    const job = (await jobsList()).find((j) => j.status === 'awaiting_approval');
    return job ?? null;
  });
  evidence.awaitingJobId = awaiting.jobId;
  console.log(`\n=== ACTION REQUIRED (phone) ===\nTap ✅ APPROVE on the LEASH settlement card (job fee ${FEE} TestUSD → ${feeRecipient.address}).\n===============================\n`);

  // ---------- 6. Wait for the phone APPROVE → governed ERC-20 settle + PoA ----------
  const settled = await waitUntil('job settled (governed ERC-20 transfer + PoA)', 7_200_000, async () => {
    const job = (await jobsList()).find((j) => j.status === 'settled');
    return job ?? null;
  });
  evidence.settlement = {
    jobId: settled.jobId,
    status: settled.status,
    settlementTx: settled.settlementTx,
    feeToken: TEST_USD,
    feeAmountWei: FEE,
    feeRecipient: feeRecipient.address,
    poa: settled.poa ?? null,
  };
  // Confirm the ERC-20 settlement on-chain + the recipient actually received the fee.
  const rc = await pub.getTransactionReceipt({ hash: settled.settlementTx });
  if (rc.status !== 'success') throw new Error('settlement tx not successful on-chain');
  const recipBal = await pub.readContract({ address: TEST_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [feeRecipient.address] });
  evidence.settlement.recipientTestUsdBalance = recipBal.toString();
  if (recipBal < BigInt(FEE)) throw new Error(`recipient did not receive the fee: ${recipBal}`);
  console.log(`SETTLE ✓ job ${settled.jobId} settled, tx ${settled.settlementTx}, recipient holds ${recipBal} TestUSD`);

  // Multi-party PoA + owner/audit stream record.
  const rec = await api('/api/owner/records?limit=200');
  evidence.poaOnOwnerStream = (rec.body.records ?? []).some((r) => r.kind === 'poa');

  // ---------- 7. teardown ----------
  for (const a of [requester, provider, evaluator]) {
    const rev = await api(`/api/agents/${a.agentId}/revoke`, { method: 'POST', body: '{}' });
    if (rev.status >= 300) console.error(`teardown revoke ${a.agentId} failed:`, rev.status, rev.body);
  }

  const outPath = new URL('../../docs/evidence/phase4-d-job-10.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log('\nPHASE-4 D-JOB-10 DEPLOYED DRILL: PASS');
  console.log('evidence →', outPath.pathname);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => { console.error('D-JOB-10 DEPLOYED DRILL: FAIL —', e.message); process.exit(1); });
