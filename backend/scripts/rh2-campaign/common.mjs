// RH2 E2E Phase-A campaign harness — shared lib.
// Headless SIWE owner (key persisted per campaign owner name), api helper
// against the rh2 branch backend, and a findings logger (JSONL + md table).
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http } from 'viem';

export const API = process.env.RH2_API ?? 'https://leash-0g-backend-rh2.onrender.com';
export const PROD_API = 'https://leash-0g-backend.onrender.com';
const FE_DOMAIN = 'leash-0g-web.vercel.app';
const STATE_DIR = new URL('./state/', import.meta.url);
const FINDINGS = new URL('../../../tasks/e2e-rh-findings.md', import.meta.url);

export const env = {};
for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const i = t.indexOf('=');
    env[t.slice(0, i)] = t.slice(i + 1);
  }
}

export const chains = {
  16602: { id: 16602, name: '0G-Galileo', rpc: env.ZERO_G_RPC },
  46630: { id: 46630, name: 'Robinhood', rpc: process.env.RH_RPC ?? 'http://127.0.0.1:8899' },
  84532: { id: 84532, name: 'Base Sepolia', rpc: env.BASE_SEPOLIA_RPC },
};
export function clients(chainId) {
  const c = chains[chainId];
  const chain = { id: c.id, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } };
  const pub = createPublicClient({ chain, transport: http(c.rpc) });
  const key = env.OPS_PRIVATE_KEY.startsWith('0x') ? env.OPS_PRIVATE_KEY : `0x${env.OPS_PRIVATE_KEY}`;
  const ops = privateKeyToAccount(key);
  return { pub, ops, opsWallet: createWalletClient({ account: ops, chain, transport: http(c.rpc) }) };
}

// Persistent campaign owner: same wallet across stages (fixtures survive).
export function campaignOwner(name = 'owner-a') {
  mkdirSync(STATE_DIR, { recursive: true });
  const f = new URL(`${name}.key`, STATE_DIR);
  let pk;
  if (existsSync(f)) pk = readFileSync(f, 'utf8').trim();
  else { pk = generatePrivateKey(); writeFileSync(f, pk, { mode: 0o600 }); }
  return privateKeyToAccount(pk);
}

export async function privyLogin(owner) {
  const H = { 'privy-app-id': env.PRIVY_APP_ID, 'content-type': 'application/json', origin: `https://${FE_DOMAIN}` };
  const init = await fetch('https://auth.privy.io/api/v1/siwe/init', { method: 'POST', headers: H, body: JSON.stringify({ address: owner.address }) });
  if (!init.ok) throw new Error(`siwe/init ${init.status}: ${await init.text()}`);
  const { nonce } = await init.json();
  const message = `${FE_DOMAIN} wants you to sign in with your Ethereum account:\n${owner.address}\n\nBy signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.\n\nURI: https://${FE_DOMAIN}\nVersion: 1\nChain ID: 16602\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nResources:\n- https://privy.io`;
  const signature = await owner.signMessage({ message });
  const auth = await fetch('https://auth.privy.io/api/v1/siwe/authenticate', {
    method: 'POST', headers: H,
    body: JSON.stringify({ message, signature, walletClientType: 'rainbow', connectorType: 'injected', mode: 'login-or-sign-up' }),
  });
  if (!auth.ok) throw new Error(`siwe/authenticate ${auth.status}: ${await auth.text()}`);
  return (await auth.json()).token;
}

export function makeApi(token, base = API) {
  return async function api(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    let body; const text = await res.text();
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
    return { status: res.status, body, headers: res.headers };
  };
}

export async function warm(base = API) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/healthz`).catch(() => null);
    if (r?.ok) return;
    await sleep(6000);
  }
  throw new Error(`backend at ${base} never became healthy`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
export function record(id, pass, note = '') {
  const line = `| ${id} | ${pass ? 'PASS' : '**FAIL**'} | ${String(note).replace(/\n/g, ' ').slice(0, 220)} |`;
  results.push(line);
  console.log(`${pass ? '✓' : '✗ FAIL'} ${id} ${note}`);
  appendFileSync(FINDINGS, line + '\n');
}
export function section(title) {
  appendFileSync(FINDINGS, `\n### ${title} — ${new Date().toISOString()}\n| case | result | note |\n|---|---|---|\n`);
  console.log(`\n== ${title} ==`);
}
export function summary(stage) {
  const fails = results.filter((r) => r.includes('FAIL')).length;
  console.log(`\n${stage}: ${results.length} cases, ${fails} FAIL`);
  return fails;
}
