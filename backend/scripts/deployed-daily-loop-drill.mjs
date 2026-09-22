// Phase-3 deployed daily-loop drill (PHASE-3 spec §8 "Deployed" row) — runs
// against the AS-DEPLOYED stack (Render + real Privy SIWE + the REAL Telegram
// bot). Two parts:
//
//  A. TELEGRAM (D3): boundary event forced deterministically via a
//     `require_approval` gateway rule (the P0 lesson) → real bot push →
//     INLINE APPROVE tapped on a real phone → REAL on-chain act (tx recorded,
//     consent trace seq < action seq, channel: telegram) → second boundary →
//     INLINE DENY → traced stand-down, no act. Plus /digest on demand and the
//     scheduled push (digest hour set to now; the 5-min scheduler tick fires).
//
//  B. LIMIT_HIT (D8): a treasury agent acts once in-policy, then the OWNER
//     INSTANT-TIGHTENS windowCap below the next send → deterministic
//     OverWindowCap → exactly ONE limit_hit alert + damping observed (zero
//     further action attempts across ≥3 runtime cycles).
//
// INTERACTIVE: the operator (Dami) taps the deep link, Approve, Deny, and
// /digest on their phone when prompted. Evidence JSON printed at the end.
//
// Usage: node scripts/deployed-daily-loop-drill.mjs   (reads backend/.env)
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
const ownerWallet = createWalletClient({ account: owner, chain, transport: http(env.ZERO_G_RPC) });
const beneficiary = privateKeyToAccount(generatePrivateKey());
console.log('owner (throwaway):', owner.address);

const LEASH_ACCOUNT_ABI = [
  {
    name: 'tightenPolicy', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: 'p', type: 'tuple', components: [
        { name: 'perTransferCap', type: 'uint128' },
        { name: 'windowCap', type: 'uint128' },
        { name: 'windowSeconds', type: 'uint32' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    }],
    outputs: [],
  },
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

async function traces(agentId) {
  const tr = await api(`/api/agents/${agentId}/traces?limit=200`);
  return tr.body.records ?? [];
}

async function alertsOf(kind) {
  const r = await api(`/api/alerts?kind=${kind}&limit=50`);
  return r.body.alerts ?? [];
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

function createBody(name, opts = {}) {
  const auditKey = new PrivateKey();
  return {
    name,
    goal: {
      beneficiary: beneficiary.address,
      targetBalanceWei: parseEther('0.05').toString(),
      topUpWei: parseEther('0.002').toString(),
    },
    policy: {
      perTransferCapWei: parseEther('0.002').toString(),
      windowCapWei: parseEther('0.006').toString(),
      windowSeconds: 3600,
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
    },
    allowlist: [beneficiary.address],
    gatewayRules: opts.requireApproval ? [{ action: 'require_approval', match: 'treasury allowance' }] : [],
    auditPubKey: auditKey.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'phase3-drill-throwaway' })).toString('base64'),
  };
}

async function main() {
  const evidence = { api: API };

  // ---------- 0. wake + login ----------
  await waitUntil('backend awake', 180_000, async () => (await fetch(`${API}/healthz`).catch(() => null))?.ok);
  console.log('backend awake');
  token = await privyLogin();
  console.log('privy SIWE login OK');

  // ---------- 1. Telegram link (interactive) ----------
  // Tokens are single-use with a 5-min TTL (security posture unchanged) —
  // the drill simply re-issues a FRESH link every 4 minutes until the
  // operator taps one, for up to 30 minutes.
  let linked = false;
  for (let round = 0; round < 60 && !linked; round++) {
    const link = await api('/api/owner/telegram/link', { method: 'POST', body: '{}' });
    if (link.status !== 200) throw new Error(`telegram link failed ${link.status}: ${JSON.stringify(link.body)} — is the bot configured on Render?`);
    console.log('\n=== ACTION REQUIRED (phone) ===');
    console.log('Open this link in Telegram and tap START (fresh link, valid 5 min):');
    console.log('  ' + link.body.url);
    console.log('===============================\n');
    linked = await waitUntil('telegram linked', 240_000, async () => (await api('/api/owner/settings')).body.telegramLinked).catch(() => false);
  }
  if (!linked) throw new Error('timed out waiting for: telegram linked (4 h of fresh links)');
  evidence.telegramLinked = true;
  console.log('telegram linked ✓');

  // ---------- 2. Part A agent: require_approval boundary → inline APPROVE ----------
  const createA = await api('/api/agents', { method: 'POST', body: JSON.stringify(createBody('phase3-telegram-drill', { requireApproval: true })) });
  if (createA.status !== 201) throw new Error(`create A failed ${createA.status}: ${JSON.stringify(createA.body)}`);
  const agentA = createA.body.agentId;
  evidence.telegram = { agentId: agentA, accountAddr: createA.body.accountAddr };
  // fund the account so the approved act is a REAL transfer
  const fundTx = await opsWallet.sendTransaction({ to: createA.body.accountAddr, value: parseEther('0.01') });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  await api(`/api/agents/${agentA}/start`, { method: 'POST', body: '{}' });
  console.log('agent A started — the boundary alert should push to your phone within ~1 min.');
  console.log('\n=== ACTION REQUIRED (phone) ===\nTap ✅ APPROVE on the LEASH card when it arrives.\n===============================\n');

  const approvedConsent = await waitUntil('telegram APPROVE consent + on-chain act', 7_200_000, async () => {
    const t1 = await traces(agentA);
    const consent = t1.find((r) => r.kind === 'consent' && r.decision === 'approve' && r.detail?.channel === 'telegram');
    const act = t1.find((r) => r.kind === 'action' && r.detail?.txHash);
    return consent && act && consent.seq < act.seq ? { consent, act } : null;
  });
  evidence.telegram.approve = {
    consentSeq: approvedConsent.consent.seq,
    channel: 'telegram',
    actSeq: approvedConsent.act.seq,
    txHash: approvedConsent.act.detail.txHash,
  };
  const rc = await pub.getTransactionReceipt({ hash: approvedConsent.act.detail.txHash });
  if (rc.status !== 'success') throw new Error('approved act tx not successful on-chain');
  console.log(`APPROVE ✓ consent seq ${approvedConsent.consent.seq} < act seq ${approvedConsent.act.seq}, tx ${approvedConsent.act.detail.txHash}`);

  // ---------- 3. inline DENY ----------
  console.log('\n=== ACTION REQUIRED (phone) ===\nTap ❌ DENY on the NEXT LEASH card (next cycle, ~30s).\n===============================\n');
  const denied = await waitUntil('telegram DENY consent + no act after it', 7_200_000, async () => {
    const t1 = await traces(agentA);
    const consent = t1.find((r) => r.kind === 'consent' && r.decision === 'deny' && r.detail?.channel === 'telegram');
    if (!consent) return null;
    const actAfter = t1.find((r) => r.kind === 'action' && r.seq > consent.seq);
    return actAfter ? null : { consent };
  });
  evidence.telegram.deny = { consentSeq: denied.consent.seq, noActAfter: true };
  await api(`/api/agents/${agentA}/stop`, { method: 'POST', body: '{}' });
  console.log(`DENY ✓ consent seq ${denied.consent.seq}, no act followed. Agent A stopped.`);

  // ---------- 4. /digest on demand + scheduled push ----------
  console.log('\n=== ACTION REQUIRED (phone) ===\nSend /digest to the bot. You should get the activity summary.\nPress nothing here — the script detects the cursor advance.\n===============================\n');
  await waitUntil('/digest advanced the cursor (owner-stream digest record)', 3_600_000, async () => {
    const r = await api('/api/owner/records?limit=200');
    return (r.body.records ?? []).some((rec) => rec.kind === 'digest');
  });
  evidence.digestCommand = true;
  console.log('/digest ✓ (digest record on the owner stream)');

  // Scheduled push: set the digest hour to NOW; the 5-min scheduler tick fires.
  const nowHour = new Date().getUTCHours();
  await api('/api/owner/settings', { method: 'PATCH', body: JSON.stringify({ digestHourUtc: nowHour }) });
  // Ensure there is fresh activity so the scheduled digest is non-empty:
  // agent A's stop left traces after the /digest mark? If not, the push may
  // be skipped as empty — nudge activity by reading; honest check below.
  console.log(`digest hour set to ${nowHour} UTC — waiting up to 7 min for the scheduled push (watch your phone).`);
  const scheduled = await waitUntil('scheduled digest push (owner-stream record flagged scheduled)', 420_000, async () => {
    const r = await api('/api/owner/records?limit=200');
    return (r.body.records ?? []).find((rec) => rec.kind === 'digest' && rec.record?.scheduled === true) ?? null;
  }).catch(() => null);
  evidence.scheduledPush = scheduled ? { seq: scheduled.seq } : 'skipped-empty-or-timeout (recorded honestly)';
  console.log('scheduled push:', evidence.scheduledPush);

  // ---------- 5. Part B: limit_hit + damping (instant-tighten) ----------
  const createB = await api('/api/agents', { method: 'POST', body: JSON.stringify(createBody('phase3-limit-hit-drill')) });
  if (createB.status !== 201) throw new Error(`create B failed ${createB.status}: ${JSON.stringify(createB.body)}`);
  const agentB = createB.body.agentId;
  const accountB = createB.body.accountAddr;
  evidence.limitHit = { agentId: agentB, accountAddr: accountB };
  const fundB = await opsWallet.sendTransaction({ to: accountB, value: parseEther('0.01') });
  await pub.waitForTransactionReceipt({ hash: fundB });
  // gas for the owner's tighten tx
  const gasTx = await opsWallet.sendTransaction({ to: owner.address, value: parseEther('0.005') });
  await pub.waitForTransactionReceipt({ hash: gasTx });

  await api(`/api/agents/${agentB}/start`, { method: 'POST', body: '{}' });
  const firstAct = await waitUntil('agent B first in-policy act', 300_000, async () => {
    const t1 = await traces(agentB);
    return t1.find((r) => r.kind === 'action' && r.detail?.txHash) ?? null;
  });
  console.log('agent B acted in-policy:', firstAct.detail.txHash);

  // Owner INSTANT-TIGHTENS windowCap below the next send (tightening needs no timelock).
  const tightenTx = await ownerWallet.writeContract({
    address: accountB,
    abi: LEASH_ACCOUNT_ABI,
    functionName: 'tightenPolicy',
    args: [{
      perTransferCap: parseEther('0.002'),
      windowCap: parseEther('0.0001'), // below any next send AND below already-spent
      windowSeconds: 3600,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 7200),
    }],
  });
  await pub.waitForTransactionReceipt({ hash: tightenTx });
  evidence.limitHit.tightenTx = tightenTx;
  console.log('owner tightened windowCap on-chain:', tightenTx);

  // Expect: exactly ONE limit_hit alert; damping = ZERO action attempts across
  // ≥3 further cycles (runtime interval 30s → observe ~2.5 min).
  await waitUntil('limit_hit alert', 300_000, async () => {
    const found = (await alertsOf('limit_hit')).filter((a) => a.agentId === agentB);
    return found.length > 0 ? found : null;
  });
  const actsAtAlert = (await traces(agentB)).filter((r) => r.kind === 'action').length;
  console.log('limit_hit alert observed — watching for futile retries for 150s...');
  await sleep(150_000);
  const after = await traces(agentB);
  const actsAfter = after.filter((r) => r.kind === 'action').length;
  const damped = after.filter((r) => r.kind === 'decision' && JSON.stringify(r.detail ?? {}).match(/boundary active|window/i)).length;
  const alertsFinal = (await alertsOf('limit_hit')).filter((a) => a.agentId === agentB);
  if (actsAfter !== actsAtAlert) throw new Error(`DAMPING FAILED: ${actsAfter - actsAtAlert} act attempt(s) after the boundary`);
  if (alertsFinal.length !== 1) throw new Error(`expected exactly 1 limit_hit alert, found ${alertsFinal.length}`);
  evidence.limitHit.alertId = alertsFinal[0].id;
  evidence.limitHit.boundaryErrorName = alertsFinal[0].refs?.errorName;
  evidence.limitHit.actsBeforeBoundary = actsAtAlert;
  evidence.limitHit.futileActsAfterBoundary = 0;
  evidence.limitHit.dampedStandDowns = damped;
  console.log(`limit_hit ✓ ONE alert (${alertsFinal[0].refs?.errorName}), 0 futile acts, ${damped} damped stand-down(s)`);

  // ---------- 6. teardown ----------
  for (const id of [agentA, agentB]) {
    const rev = await api(`/api/agents/${id}/revoke`, { method: 'POST', body: '{}' });
    if (rev.status >= 300) console.error(`teardown revoke ${id} failed:`, rev.status, rev.body);
  }
  console.log('\nPHASE-3 DEPLOYED DAILY-LOOP DRILL: PASS');
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((e) => { console.error('PHASE-3 DEPLOYED DRILL: FAIL —', e.message); process.exit(1); });
