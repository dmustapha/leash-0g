// Deployed-stack Create-Funnel drill (Phase-5, D-A5 / D-B7) — drives the LIVE
// Render backend + 0G testnet through the intent-first funnel with REAL Privy auth
// (headless SIWE, throwaway owner):
//   job-specs (D-A2 empty) → elevate on real 0G Compute (D-B1) → assert quarantine
//   (no agent created by /elevate, D-B2) + never-guess-money (no address in draft, D-B4)
//   → confirm-create the elevated draft (D-B7/D-A5) → agent operable + capabilityLabel
//   round-trips (D-B9).
// Usage: node scripts/deployed-create-funnel-drill.mjs   (reads backend/.env for
// PRIVY_APP_ID + RPC; owner wallet generated fresh each run; spend-incapable
// provider agent = no funding needed).
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

  // D-A2: a fresh owner's saved job specs list is reachable + empty (not a dead-end).
  const specs = await api('/api/job-specs');
  if (specs.status !== 200) throw new Error(`job-specs ${specs.status}: ${JSON.stringify(specs.body)} — is Phase-5 deployed?`);
  if (!Array.isArray(specs.body.specs)) throw new Error('job-specs shape wrong');
  console.log('D-A2 GET /api/job-specs OK — specs:', specs.body.specs.length);

  // D-B1: spec-elevation on real 0G Compute. role hint 'provider' → deterministic,
  // spend-incapable (no funding), and the safe fallback is also a provider.
  const intent = 'summarize research papers into a few calibrated bullet points';
  const elev = await api('/api/create/elevate', { method: 'POST', body: JSON.stringify({ intent, role: 'provider' }) });
  if (elev.status !== 200) throw new Error(`elevate ${elev.status}: ${JSON.stringify(elev.body)}`);
  const draft = elev.body.draft;
  if (!draft || typeof draft.proposedRole !== 'string') throw new Error('no draft returned');
  console.log('D-B1 elevate OK — role:', draft.proposedRole, '| confidence:', draft.confidence, '| label:', draft.capabilityLabel);

  // D-B4 never-guess-money: the draft carries NO address, ever.
  if (/0x[0-9a-fA-F]{40}/.test(JSON.stringify(draft))) throw new Error('D-B4 FAIL: draft contains an address');
  console.log('D-B4 OK — draft carries no address (never-guess-money)');

  // D-B2 quarantine: /elevate created NOTHING — the owner still has zero agents.
  const before = await api('/api/agents');
  if ((before.body.agents ?? []).length !== 0) throw new Error('D-B2 FAIL: /elevate created an agent (quarantine breach)');
  console.log('D-B2 OK — /elevate wrote nothing (0 agents before confirm)');

  // D-B7 / D-A5: confirm the elevated draft → the existing create path. A spend-
  // incapable worker (provider/evaluator) needs zero caps + empty allowlist.
  if (draft.proposedRole !== 'provider' && draft.proposedRole !== 'evaluator') {
    throw new Error(`drill expects a spend-incapable role; got ${draft.proposedRole}`);
  }
  const goal = draft.proposedRole === 'evaluator'
    ? { type: 'evaluator', rubricRef: (draft.rubricRef || intent).slice(0, 400) }
    : { type: 'provider', serviceSpec: (draft.serviceSpec || intent).slice(0, 2000) };
  const auditKey = new PrivateKey();
  const capabilityLabel = (draft.capabilityLabel || 'research summarizer').slice(0, 120);
  const create = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: capabilityLabel,
      goal,
      policy: { perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 86400, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
      allowlist: [],
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'funnel-drill-throwaway' })).toString('base64'),
      capabilityLabel,
    }),
  });
  if (create.status !== 201 && create.status !== 200) throw new Error(`create failed ${create.status}: ${JSON.stringify(create.body)}`);
  const { agentId, accountAddr, txHashes } = create.body;
  console.log('D-B7/D-A5 confirm→create OK — agent', agentId, 'account', accountAddr, 'txs', txHashes);

  // Operable: the agent detail loads, is a valid agent, and capabilityLabel round-tripped (D-B9).
  await sleep(3000);
  const detail = await api(`/api/agents/${agentId}`);
  if (detail.status !== 200) throw new Error(`detail ${detail.status}`);
  const gotLabel = detail.body.agent?.capabilityLabel;
  if (gotLabel !== capabilityLabel) throw new Error(`D-B9 FAIL: capabilityLabel '${gotLabel}' !== '${capabilityLabel}'`);
  console.log('D-B9 OK — capabilityLabel round-tripped in cockpit detail:', gotLabel);
  console.log('agent operable — status:', detail.body.status);

  const result = {
    ts: new Date().toISOString(),
    owner: owner.address,
    jobSpecsReachable: true,
    elevate: { role: draft.proposedRole, confidence: draft.confidence, noAddress: true, capabilityLabel: draft.capabilityLabel },
    quarantine_no_write_on_elevate: true,
    agentId, accountAddr, createTxs: txHashes,
    capabilityLabelRoundTrip: gotLabel,
    operableStatus: detail.body.status,
  };
  console.log('\nDEPLOYED CREATE-FUNNEL DRILL: PASS');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error('DEPLOYED CREATE-FUNNEL DRILL: FAIL —', e.message); process.exit(1); });
