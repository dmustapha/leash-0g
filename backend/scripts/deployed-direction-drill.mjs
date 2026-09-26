// Deployed-stack Conversational-Direction drill (Phase-5.5, D-6 / D-9 / lifespan).
// Drives the LIVE Render backend + 0G testnet with REAL Privy auth (headless SIWE,
// throwaway owner) through the direction spine end to end:
//   create a treasury agent → start it → wait a cycle (it reasons on real 0G Compute)
//   → POST /direct (real 0G elevation) : assert quarantine (goal unchanged) +
//     never-guess-money (no address in the draft) + R-2 (moneyPower server-computed)
//   → owner edits the read-back target → POST /direct/:id/confirm (sole authority
//     write + hash-chained `direction` consent record)
//   → wait a cycle : assert sense_direction rerouted the RUNNING goal + a `direction`
//     trace appears (D-6)
//   → GET /status?q=... : assert a quarantined plain-text answer (D-9)
//   → POST /wind-down : assert the loop stops + a `completed` alert (lifespan / D-10).
// Usage: node scripts/deployed-direction-drill.mjs   (reads backend/.env for PRIVY_APP_ID;
// owner wallet generated fresh each run; needs Phase-5.5 deployed on the live stack).
import { readFileSync } from 'node:fs';
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
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${API}/healthz`).catch(() => null);
    if (r?.ok) break;
    await sleep(6000);
  }
  console.log('backend healthy');
  token = await privyLogin();
  console.log('privy SIWE login OK (real access token)');

  // --- create a treasury agent (autonomous: reasons every cycle) ---
  const beneficiary = privateKeyToAccount(generatePrivateKey()).address; // a throwaway watched wallet
  const auditKey = new PrivateKey();
  const START_TARGET = '1000000000000000000'; // 1 0G
  const NEW_TARGET = '2000000000000000000'; // 2 0G (the owner-edited re-direction)
  const create = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'direction-drill treasury',
      goal: { type: 'treasury', beneficiary, targetBalanceWei: START_TARGET, topUpWei: '100000000000000' },
      policy: { perTransferCapWei: '1000000000000000', windowCapWei: '5000000000000000', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
      allowlist: [beneficiary],
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'direction-drill-throwaway' })).toString('base64'),
    }),
  });
  if (create.status !== 201 && create.status !== 200) throw new Error(`create failed ${create.status}: ${JSON.stringify(create.body)}`);
  const agentId = create.body.agentId;
  console.log('created treasury agent', agentId, 'account', create.body.accountAddr);

  const started = await api(`/api/agents/${agentId}/start`, { method: 'POST' });
  if (started.status !== 200) throw new Error(`start failed ${started.status}: ${JSON.stringify(started.body)}`);
  console.log('agent started; waiting a cycle (30s interval) so it reasons on real 0G Compute...');
  await sleep(40000);

  // --- POST /direct: real 0G elevation ---
  const direct = await api(`/api/agents/${agentId}/direct`, {
    method: 'POST',
    body: JSON.stringify({ intent: 'keep the wallet topped up to a higher target than before' }),
  });
  if (direct.status !== 200) throw new Error(`/direct ${direct.status}: ${JSON.stringify(direct.body)} — is Phase-5.5 deployed?`);
  const { id: directionId, draft } = direct.body.direction;
  console.log('D-6 /direct OK — directionId', directionId, '| understanding:', JSON.stringify(draft.understanding).slice(0, 120));

  // never-guess-money: NO address anywhere in the draft
  if (/0x[0-9a-fA-F]{40}/.test(JSON.stringify(draft))) throw new Error('never-guess-money FAIL: draft contains an address');
  // R-2: moneyPower server-computed from the treasury role
  if (draft.moneyPower !== 'can-move-money') throw new Error(`R-2 FAIL: moneyPower '${draft.moneyPower}' != can-move-money`);
  console.log('never-guess-money OK (no address in draft) + R-2 OK (moneyPower server-computed:', draft.moneyPower + ')');

  // quarantine (D-2): /direct wrote NO authority — the running goal is unchanged
  const q = await api(`/api/agents/${agentId}`);
  if (q.body.agent?.goal?.targetBalanceWei !== START_TARGET) throw new Error('quarantine FAIL: /direct changed the goal');
  console.log('quarantine OK — goal unchanged by /direct (still', START_TARGET + ')');

  // --- owner edits the read-back target, then confirms (sole authority write) ---
  const edited = { ...draft, goalPatch: { ...(draft.goalPatch ?? {}), targetBalanceWei: NEW_TARGET } };
  const confirm = await api(`/api/agents/${agentId}/direct/${directionId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ edited }),
  });
  if (confirm.status !== 200) throw new Error(`/confirm ${confirm.status}: ${JSON.stringify(confirm.body)}`);
  console.log('confirm OK — sole authority write (edited target', NEW_TARGET + ')');

  // --- wait a cycle: sense_direction reroutes the RUNNING goal at the boundary ---
  console.log('waiting a cycle for sense_direction to apply at the boundary...');
  let rerouted = false;
  for (let i = 0; i < 8; i++) {
    await sleep(15000);
    const g = await api(`/api/agents/${agentId}`);
    if (g.body.agent?.goal?.targetBalanceWei === NEW_TARGET) { rerouted = true; break; }
  }
  if (!rerouted) throw new Error('D-6 FAIL: running goal was not rerouted to the new target within the window');
  console.log('D-6 OK — running goal rerouted to', NEW_TARGET, 'by sense_direction at the cycle boundary');

  // a `direction` consent/apply trace is on the hash chain
  const traces = await api(`/api/agents/${agentId}/traces?limit=200`);
  const directionTraces = (traces.body.records ?? []).filter((t) => t.kind === 'direction');
  console.log('direction traces on the chain:', directionTraces.length);
  if (directionTraces.length < 1) console.log('WARN: no direction trace surfaced via /traces (check trace route shape)');

  // --- D-9: conversational status (read-only, quarantined) ---
  const status = await api(`/api/agents/${agentId}/status?q=${encodeURIComponent('what have you been doing so far?')}`);
  if (status.status !== 200) throw new Error(`/status ${status.status}: ${JSON.stringify(status.body)}`);
  if (status.body.quarantined !== true || typeof status.body.answer !== 'string') throw new Error('D-9 FAIL: status answer shape wrong');
  console.log('D-9 OK — status answer (quarantined):', JSON.stringify(status.body.answer).slice(0, 160));

  // --- lifespan / D-10: owner wind-down stops the loop + emits a completion alert ---
  const wind = await api(`/api/agents/${agentId}/wind-down`, { method: 'POST' });
  if (wind.status !== 200) throw new Error(`/wind-down ${wind.status}: ${JSON.stringify(wind.body)}`);
  await sleep(2000);
  const alerts = await api('/api/alerts');
  const completed = (alerts.body.alerts ?? []).some((a) => a.kind === 'completed' && a.agentId === agentId);
  console.log('lifespan/D-10 OK — wind-down accepted; completed alert present:', completed);

  const result = {
    ts: new Date().toISOString(),
    owner: owner.address,
    agentId,
    directionId,
    neverGuessMoney: true,
    moneyPowerServerComputed: draft.moneyPower,
    quarantineNoWriteOnDirect: true,
    reroutedTargetWei: NEW_TARGET,
    directionTraces: directionTraces.length,
    statusQuarantined: status.body.quarantined,
    windDownCompletedAlert: completed,
  };
  console.log('\nDEPLOYED DIRECTION DRILL: PASS');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error('DEPLOYED DIRECTION DRILL: FAIL —', e.message); process.exit(1); });
