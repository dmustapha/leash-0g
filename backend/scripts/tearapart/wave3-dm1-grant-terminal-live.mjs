/**
 * WAVE-3 DM-1 — LIVE reverify on the rh2 Render stack that a 'removed' capability
 * grant is TERMINAL: `apply` can no longer resurrect it to 'active' (commit b22f6dc).
 *
 * Drives the real deployed HTTP routes (SIWE owner) against leash-0g-backend-rh2:
 *   1. create a throwaway treasury agent (owner = campaign owner-a)
 *   2. propose a capability call-rule (selector S1)        → grant 'proposed'
 *   3. remove it                                           → grant 'removed' (terminal)
 *   4. apply it again                                      → EXPECT 409 'grant is removed'  ← THE FIX
 *   5. CONTROL: propose a DIFFERENT rule (selector S2)     → 'proposed'
 *   6. apply S2                                            → EXPECT ok (proposed→active still works)
 *   7. read back the grants: S1 stays 'removed', S2 is 'active'
 *
 * Pre-fix, step 4 returned ok:true and flipped S1 back to 'active' (cockpit-honesty drift).
 * Run:  node scripts/tearapart/wave3-dm1-grant-terminal-live.mjs   (no owner gas; create uses the ops float)
 */
import { parseEther } from 'viem';
import { PrivateKey } from 'eciesjs';
import { campaignOwner, privyLogin, makeApi } from '../rh2-campaign/common.mjs';

const TARGET = '0x1111111111111111111111111111111111111111';
const S1 = '0xdeadbeef'; // the rule we remove then try to resurrect
const S2 = '0xfeedface'; // the control rule (proposed→apply→active)

function rule(selector) {
  return {
    target: TARGET,
    selector,
    recipientMode: 'self',
    spenderSet: [],
    perCallCap: parseEther('0.001').toString(),
    windowCapCall: parseEther('0.002').toString(),
  };
}

async function main() {
  const owner = campaignOwner('owner-a');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  console.log('owner', owner.address);

  const auditKey = new PrivateKey();
  const create = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `dm1-live-${Date.now()}`,
      goal: { beneficiary: owner.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.002').toString() },
      policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
      allowlist: [owner.address],
      accountVersion: 4,
      auditPubKey: auditKey.publicKey.toHex(),
      encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'dm1-live-throwaway' })).toString('base64'),
    }),
  });
  if (create.status !== 201 && create.status !== 200) throw new Error(`create failed ${create.status}: ${JSON.stringify(create.body)}`);
  const agentId = create.body.agentId;
  console.log('agent', agentId, 'account', create.body.accountAddr);

  // propose must carry a txHash so the route's upsertGrant actually creates the
  // read-model grant row (status 'proposed'); without it propose records nothing.
  const TX = '0x' + '11'.repeat(32);
  const capRule = (action, selector, withTx) =>
    api(`/api/agents/${agentId}/capabilities/rule`, {
      method: 'POST',
      body: JSON.stringify({ action, rule: rule(selector), ...(withTx ? { txHash: TX } : {}) }),
    });

  const prop1 = await capRule('propose', S1, true);
  const rem1 = await capRule('remove', S1, false);
  const apply1 = await capRule('apply', S1, false);   // ← must 409 (terminal)
  const prop2 = await capRule('propose', S2, true);
  const apply2 = await capRule('apply', S2, false);   // ← control: must succeed

  const grantsRes = await api(`/api/agents/${agentId}/capabilities`);
  const grants = Array.isArray(grantsRes.body) ? grantsRes.body : (grantsRes.body.grants || grantsRes.body.rules || []);
  const statusOf = (sel) => (grants.find((g) => (g.selector || '').toLowerCase() === sel.toLowerCase()) || {}).status;

  const checks = [
    ['propose S1 (+tx) → ok', prop1.status === 200 || prop1.status === 201],
    ['remove  S1 → ok', rem1.status === 200],
    ['★ apply removed S1 → 409 (terminal, FIX)', apply1.status === 409],
    ['  (409 body says removed)', JSON.stringify(apply1.body).includes('removed')],
    ['propose S2 (+tx) → ok', prop2.status === 200 || prop2.status === 201],
    ['control apply proposed S2 → ok', apply2.status === 200 || apply2.status === 201],
    ['read-back: S1 removed → excluded from cockpit view', statusOf(S1) === undefined],
    ['read-back: S2 is active', statusOf(S2) === 'active'],
  ];
  console.log('\n=== WAVE-3 DM-1 — GRANT-REMOVED-TERMINAL (LIVE on rh2) ===');
  let allOk = true;
  for (const [label, ok] of checks) { allOk &&= ok; console.log(`${ok ? '✅' : '❌'} ${label}`); }
  console.log(`\napply1 status=${apply1.status} body=${JSON.stringify(apply1.body)}`);
  console.log(`read-back S1=${statusOf(S1)} S2=${statusOf(S2)}`);
  console.log(allOk ? '\nDM-1 FIX HOLDS LIVE ✅' : '\nFAILURES PRESENT ❌');
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
