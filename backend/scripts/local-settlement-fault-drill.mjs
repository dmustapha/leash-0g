// AQ-A0-Q2VIS Unit-1 fault-injection drill — LOCAL ONLY.
//
// Proves the settlement-loss class is closed, end to end, on a booted backend.
// The unit + integration tests already cover the pieces in isolation; what only a
// live run can show is the union: the write-ahead fires inside a REAL governed
// ERC-20 broadcast, the job is left `'settling'` rather than `'failed'`, and the
// lease-gated `settlementSweepTimer` wired in src/index.ts actually promotes it
// against the REAL 0G RPC — including the `jobFee` trace the owner digest keys on.
//
// THE FAULT. Run the backend with LEASH_FAULT_UNCONFIRMED=1. That makes
// `executeTokenTransfer` throw `ReceiptUnconfirmedError` immediately after
// `wallet.writeContract` returns and after `onSubmitted` has persisted the hash —
// i.e. exactly the 0G receipt-indexing failure that lost a paid settlement. The
// transfer is REAL and lands on chain; only our knowledge of it is broken.
// The injection is a temporary local patch at src/runtime/session-chain.ts, NOT a
// shipped env flag. If `pnpm typecheck` passes and that file has no
// LEASH_FAULT_UNCONFIRMED in it, the patch has been reverted correctly.
//
// Adapted from scripts/deployed-job-drill.mjs (D-JOB-10). Two deliberate
// differences, both so this can run solo:
//   1. No Telegram. The settlement approval is decided over `POST /api/approvals/:id`
//      with the owner's own SIWE token — the cockpit's rail, not the phone's.
//   2. Pinned to a LOCAL api host. The ops key signs real testnet value here
//      (TestUSD mint + gas dust), so the host/token pins from D-JOB-10 are kept.
//
// Usage: LEASH_FAULT_UNCONFIRMED=1 (on the BACKEND) then
//        node scripts/local-settlement-fault-drill.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseEther, encodeFunctionData } from 'viem';
import { PrivateKey } from 'eciesjs';

const API = process.env.DRILL_API ?? 'http://127.0.0.1:8080';
const FE_DOMAIN = 'leash-0g-web.vercel.app';
const TEST_USD = (process.env.SETTLEMENT_TOKEN ?? '0xbeeA96c7614ebc46760B442068E359e51e7c4e52').toLowerCase();

// H-02 (inherited): the ops key signs REAL value transfers below. Pin the host to
// loopback and the token to known-good TestUSD so a poisoned env cannot redirect
// them. This drill is local by definition — a non-loopback host is a mistake.
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const KNOWN_TEST_USD = '0xbeea96c7614ebc46760b442068e359e51e7c4e52';
const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
{
  const host = new URL(API).hostname;
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`refusing non-local DRILL_API host '${host}'`);
  if (TEST_USD !== KNOWN_TEST_USD) throw new Error(`refusing unpinned SETTLEMENT_TOKEN '${TEST_USD}'`);
}

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

const ERC20_ABI = [
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

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

let token;
async function api(path, opts = {}, _retried = false) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  if (res.status === 401 && !_retried) {
    token = await privyLogin();
    return api(path, opts, true);
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function waitTx(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 });
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(4_000);
    }
  }
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

const jobsList = async () => (await api('/api/jobs')).body.jobs ?? [];

const EXPIRES = Math.floor(Date.now() / 1000) + 7200;
const spendIncapablePolicy = () => ({ perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: EXPIRES });

function createRole(name, goal, extra = {}) {
  const auditKey = new PrivateKey();
  return {
    name, goal,
    policy: extra.policy ?? spendIncapablePolicy(),
    allowlist: extra.allowlist ?? [],
    gatewayRules: [],
    auditPubKey: auditKey.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'unit1-fault-drill-throwaway' })).toString('base64'),
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
  if (r.status !== 201 && r.status !== 409) throw new Error(`link failed ${r.status}: ${JSON.stringify(r.body)}`);
}

async function main() {
  const evidence = { drill: 'UNIT1-FAULT-LOCAL', api: API, settlementToken: TEST_USD, generatedAt: new Date().toISOString() };

  await waitUntil('backend awake', 60_000, async () => (await fetch(`${API}/healthz`).catch(() => null))?.ok);
  token = await privyLogin();
  console.log('backend awake + privy SIWE login OK');

  const SPEC_REF = 'eth-4000-unit1-fault';
  const FEE = (2n * 10n ** 6n).toString();
  const putSpec = await api(`/api/job-specs/${SPEC_REF}`, {
    method: 'PUT',
    body: JSON.stringify({
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
    }),
  });
  if (putSpec.status !== 200 && putSpec.status !== 201) throw new Error(`put job-spec failed ${putSpec.status}: ${JSON.stringify(putSpec.body)}`);
  console.log('job spec seeded ✓');

  const provider = await createAgent(createRole('u1-fault-provider', { type: 'provider', serviceSpec: 'market probability analysis' }));
  // NOT 'strict-calibration' (the rubric D-JOB-10 uses). Measured on this drill's
  // first run: 5/5 jobs came back `verdict: 'reject'` with the MECHANICAL floor
  // passing 4/4 — the model evaluator was rejecting a well-formed 0.45 estimate on
  // calibration grounds, so the cycle never reached settlement and the fault under
  // test never fired. `rubricRef` is opaque free text injected verbatim into the
  // evaluator prompt (`jobs/prompt.ts:108`), so the fix is to ask it to judge the
  // thing this drill actually depends on: a well-formed deliverable. The evaluator's
  // taste is not what is being proved here — the settlement write-ahead is — and
  // this does NOT short-circuit any part of that path (the fee transfer is still a
  // real governed ERC-20 broadcast produced by the product).
  const evaluator = await createAgent(createRole('u1-fault-evaluator', {
    type: 'evaluator',
    rubricRef:
      'schema-completeness: accept when the deliverable has a probability in [0,1] and a non-empty, on-topic rationale. Do not judge forecast calibration or accuracy.',
  }));
  const perTransferCapToken = (10n * 10n ** 6n).toString();
  const requester = await createAgent(createRole(
    'u1-fault-requester',
    {
      type: 'requester', jobSpecSource: SPEC_REF,
      providerAgentId: provider.agentId, evaluatorAgentId: evaluator.agentId,
      feeToken: TEST_USD, feeRecipient: feeRecipient.address,
      feeCapPerJobWei: (5n * 10n ** 6n).toString(),
    },
    {
      allowlist: [feeRecipient.address],
      tokenConfig: { settlementToken: TEST_USD, perTransferCapTokenWei: perTransferCapToken, windowCapTokenWei: (20n * 10n ** 6n).toString() },
    },
  ));
  evidence.agents = { requester, provider, evaluator };
  console.log('triangle created — requester account:', requester.accountAddr);

  await link(requester.agentId, provider.agentId);
  await link(provider.agentId, requester.agentId);
  await link(requester.agentId, evaluator.agentId);
  await link(evaluator.agentId, requester.agentId);
  console.log('links wired ✓');

  if (!isAddress(requester.accountAddr)) throw new Error(`requester.accountAddr is not an address: ${requester.accountAddr}`);
  const mintData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'mint', args: [requester.accountAddr, 50n * 10n ** 6n] });
  const mintTx = await opsWallet.sendTransaction({ to: TEST_USD, data: mintData });
  await waitTx(mintTx);
  const bal = await pub.readContract({ address: TEST_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [requester.accountAddr] });
  if (bal < BigInt(FEE)) throw new Error(`TestUSD mint did not land: balance ${bal}`);
  const gasTx = await opsWallet.sendTransaction({ to: requester.accountAddr, value: parseEther('0.01') });
  await waitTx(gasTx);
  evidence.funding = { mintTx, testUsdBalance: bal.toString(), gasTx };
  console.log(`funded ✓ requester holds ${bal} TestUSD base-units`);

  for (const a of [provider, evaluator, requester]) {
    await api(`/api/agents/${a.agentId}/start`, { method: 'POST', body: '{}' });
  }
  console.log('all three started — waiting for the layered gate to reach awaiting_approval…');

  const awaiting = await waitUntil('job awaiting_approval (floor + verdict passed)', 2_400_000, async () => {
    const job = (await jobsList()).find((j) => j.status === 'awaiting_approval');
    return job ?? null;
  });
  evidence.jobId = awaiting.jobId;
  console.log(`job ${awaiting.jobId} awaiting_approval ✓`);

  // Approve over the cockpit's rail rather than the phone's. The decision schema is
  // { decision: 'approve' }.
  //
  // `approvalId` is NESTED INSIDE `refs`, not top-level — a top-level `x.approvalId`
  // predicate never matches and the drill times out here even though the job reached
  // awaiting_approval (measured live, run 2, 2026-10-18). The live row:
  //   kind='approval_required' class='decision'
  //   refs={"jobId":"b64ed0fa-…","approvalId":"7d4ca166-…","feeLabel":"2 TestUSD",…}
  // The jobId match is what keeps a stale alert from an earlier run out of this.
  const approvalId = await waitUntil('settlement approval alert', 300_000, async () => {
    const alerts = (await api('/api/alerts?limit=50')).body.alerts ?? [];
    const a = alerts.find(
      (x) => x.refs?.approvalId && x.refs?.jobId === awaiting.jobId && (x.kind ?? '').includes('approval'),
    );
    return a?.refs?.approvalId ?? null;
  });
  const dec = await api(`/api/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
  if (dec.status !== 200) throw new Error(`approve failed ${dec.status}: ${JSON.stringify(dec.body)}`);
  evidence.approvalId = approvalId;
  console.log(`approved ${approvalId} ✓ — the governed ERC-20 transfer broadcasts now, and the fault makes the wait throw`);

  // ---- CLAIM 1: the job sits in 'settling' with a pending hash, NOT 'failed'. ----
  const settling = await waitUntil("job 'settling' with settlement_tx_pending", 600_000, async () => {
    const job = (await jobsList()).find((j) => j.jobId === awaiting.jobId);
    if (job && job.status === 'failed') throw new Error('REGRESSION: job booked failed on an unconfirmed settlement');
    return job && job.status === 'settling' && job.settlementTxPending ? job : null;
  });
  evidence.unconfirmed = { status: settling.status, settlementTxPending: settling.settlementTxPending };
  console.log(`CLAIM 1 ✓ settling, pending tx ${settling.settlementTxPending}`);

  // ---- CLAIM 2: the sweep promotes it on a later tick (60s timer in index.ts). ----
  const settled = await waitUntil("sweep promoted the job to 'settled'", 600_000, async () => {
    const job = (await jobsList()).find((j) => j.jobId === awaiting.jobId);
    return job && job.status === 'settled' && job.settlementTx ? job : null;
  });
  if (settled.settlementTx !== settling.settlementTxPending) {
    throw new Error(`settlement_tx ${settled.settlementTx} != pending ${settling.settlementTxPending}`);
  }
  evidence.settled = { status: settled.status, settlementTx: settled.settlementTx, poa: settled.poa ?? null };
  console.log(`CLAIM 2 ✓ swept to settled, tx ${settled.settlementTx}`);

  // ---- CLAIM 3: the transfer really did land, and the recipient really got the fee. ----
  const rc = await pub.getTransactionReceipt({ hash: settled.settlementTx });
  if (rc.status !== 'success') throw new Error('settlement tx not successful on-chain');
  const recipBal = await pub.readContract({ address: TEST_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [feeRecipient.address] });
  if (recipBal < BigInt(FEE)) throw new Error(`recipient did not receive the fee: ${recipBal}`);
  evidence.onChain = { receiptStatus: rc.status, recipientTestUsdBalance: recipBal.toString() };
  console.log(`CLAIM 3 ✓ on-chain success, recipient holds ${recipBal} TestUSD base-units`);

  // ---- CLAIM 4: the owner digest reports the fee (it keys on detail.category='jobFee'). ----
  // The route is `/api/digest` — NOT `/api/owner/digest`, which 404s as
  // `{"error":{"message":"not found"}}` and made this claim read as a false negative on the
  // first passing run (2026-10-18). `GET` is the cursor-untouched preview (owner-routes.ts:2113).
  //
  // And it is a HARD assertion, not a captured payload: "money moved, unreported" is the defect
  // class under test, so a digest that omits the fee means the fix is cosmetic. The digest's only
  // input is a trace carrying `detail.category === 'jobFee'` (digest/service.ts:168-180), which on
  // this path only the SWEEP can have written — the inline graph write never ran, the fault threw
  // before it.
  const digest = await api('/api/digest');
  if (digest.status !== 200) throw new Error(`digest fetch failed ${digest.status}: ${JSON.stringify(digest.body)}`);
  evidence.digest = digest.body?.digest ?? null;
  const digestText = JSON.stringify(digest.body?.digest ?? {});
  evidence.digestMentionsFee = digestText.includes('jobFee') || /\bfee/i.test(digestText);
  if (!evidence.digestMentionsFee) {
    throw new Error(`CLAIM 4 FAILED: digest does not report the settled fee: ${digestText}`);
  }
  console.log('CLAIM 4 ✓ owner digest reports the fee');

  // ---- CLAIM 5: a PoA reached the owner stream. ----
  const rec = await api('/api/owner/records?limit=200');
  evidence.poaOnOwnerStream = (rec.body.records ?? []).some((r) => r.kind === 'poa');
  console.log(`CLAIM 5 ${evidence.poaOnOwnerStream ? '✓' : '✗'} PoA on owner stream`);

  for (const a of [requester, provider, evaluator]) {
    const rev = await api(`/api/agents/${a.agentId}/revoke`, { method: 'POST', body: '{}' });
    if (rev.status >= 300) console.error(`teardown revoke ${a.agentId} failed:`, rev.status, rev.body);
  }
  console.log('teardown: all three revoked');

  const out = new URL('../test-live/artifacts/unit1-fault-drill.json', import.meta.url);
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log('\nevidence →', out.pathname);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => {
  console.error('\nDRILL FAILED:', e);
  process.exit(1);
});
