/**
 * WAVE-1 NC-2 — LIVE reverify on rh2 that audit/stream pubkey rotation requires an
 * owner EIP-712 signature + monotonic replay nonce (commit 23fac0d). The one back-half
 * backend fix not previously driven live (no live FE caller; backend hardened regardless).
 *
 * POST /api/owner/stream-key {pubkey, nonce, signature} — the owner must sign
 * SetAuditPubkey(owner,'owner-stream',pubkey,nonce) under domain {LEASH,1,16602}.
 *   1. valid owner sig + fresh nonce N      → 200 ok (rotation accepted)
 *   2. REPLAY same nonce N (+ its sig)       → 403 'nonce already used'
 *   3. WRONG signer (owner-b signs, claims A)→ 403 'signature does not match owner'
 *   4. no/garbage signature                  → 403 (crypto wall, fail-closed)
 *
 * Run:  node scripts/tearapart/wave1-nc2-pubkey-rotation-live.mjs
 */
import { campaignOwner, privyLogin, makeApi } from '../rh2-campaign/common.mjs';

const CHAIN_ID = 16602; // 0G-Galileo (server defaultChainId = ZERO_G_CHAIN_ID; SIWE uses 16602)
const DOMAIN = { name: 'LEASH', version: '1', chainId: CHAIN_ID };
const TYPES = {
  SetAuditPubkey: [
    { name: 'owner', type: 'address' },
    { name: 'target', type: 'string' },
    { name: 'pubkey', type: 'string' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const TARGET = 'owner-stream';
const pubkeyFor = (b) => '0x02' + String(b).repeat(32).slice(0, 64); // valid 33-byte compressed shape

async function sign(account, owner, pubkey, nonce) {
  return account.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'SetAuditPubkey',
    message: { owner, target: TARGET, pubkey, nonce },
  });
}

async function main() {
  const ownerA = campaignOwner('owner-a');
  const ownerB = campaignOwner('owner-b');
  const token = await privyLogin(ownerA);
  const api = makeApi(token);
  const post = (body) => api('/api/owner/stream-key', { method: 'POST', body: JSON.stringify(body) });

  const nonce = BigInt(Date.now()); // monotonic, > any prior rotation for this owner
  const pk = pubkeyFor('ab');

  // 1. valid
  const sigValid = await sign(ownerA, ownerA.address, pk, nonce);
  const r1 = await post({ pubkey: pk, nonce: nonce.toString(), signature: sigValid });
  // 2. replay (same nonce + sig)
  const r2 = await post({ pubkey: pk, nonce: nonce.toString(), signature: sigValid });
  // 3. wrong signer: owner-b signs a message claiming owner-a; recovered=B != A
  const sigWrong = await sign(ownerB, ownerA.address, pubkeyFor('cd'), nonce + 1n);
  const r3 = await post({ pubkey: pubkeyFor('cd'), nonce: (nonce + 1n).toString(), signature: sigWrong });
  // 4. garbage signature
  const r4 = await post({ pubkey: pubkeyFor('ef'), nonce: (nonce + 2n).toString(), signature: '0x' + '11'.repeat(65) });

  const checks = [
    ['valid owner sig + fresh nonce → 200', r1.status === 200, r1],
    ['★ replay same nonce → 403 nonce-used', r2.status === 403 && JSON.stringify(r2.body).includes('nonce'), r2],
    ['wrong signer → 403 signature-mismatch', r3.status === 403 && JSON.stringify(r3.body).includes('match'), r3],
    ['garbage signature → 403 (fail-closed)', r4.status === 403, r4],
  ];
  console.log('\n=== WAVE-1 NC-2 — AUDIT PUBKEY ROTATION EIP-712 WALL (LIVE on rh2) ===');
  let allOk = true;
  for (const [label, ok, r] of checks) { allOk &&= ok; console.log(`${ok ? '✅' : '❌'} ${label}  [${r.status} ${JSON.stringify(r.body).slice(0, 80)}]`); }
  console.log(allOk ? '\nNC-2 EIP-712 ROTATION WALL HOLDS LIVE ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
