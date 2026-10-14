// P4-LIVE (headless) — the FULL ACP job loop on the tear-apart rh2 stack:
//   owner-seeded job spec → requester originates → provider reasons (0G Compute)
//   + delivers → deterministic acceptance FLOOR → evaluator SKEPTIC verdict →
//   layered gate reaches awaiting_approval → OWNER APPROVES HEADLESSLY (POST
//   /api/approvals/:id, no phone — testnet-wallet autonomy) → governed
//   executeTokenTransfer REAL ERC-20 settle of the fee → multi-party PoA.
//
// Settlement = a GOVERNED ERC-20 transfer (server-state amount, F4) from the
// requester's token-capable LeashAccount — NOT a native send. Verified against
// receipt.status + the recipient's on-chain TestUSD balance (not thrown errors).
// Uses the common.mjs rh2 harness (headless Privy SIWE). Evidence JSON saved.
import { parseEther, encodeFunctionData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients, env } from '../rh2-campaign/common.mjs';

const CHAIN = 16602;
const { pub, opsWallet } = clients(CHAIN);
const TEST_USD = (process.env.SETTLEMENT_TOKEN ?? '0xbeeA96c7614ebc46760B442068E359e51e7c4e52');
const ERC20 = [
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const rec = (id, pass, n = '') => { console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${id}  ${n}`); return { id, pass, n }; };

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) { try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); } catch (e) { if (i === tries - 1) throw e; await sleep(4_000); } }
}
async function waitUntil(timeoutMs, fn, poll = 5000) { const d = Date.now() + timeoutMs; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > d) return null; await sleep(poll); } }
const auditKey = () => { const k = new PrivateKey(); return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'p4-live' })).toString('base64') }; };

const EXPIRES = Math.floor(Date.now() / 1000) + 7200;
const spendIncapable = () => ({ perTransferCapWei: '0', windowCapWei: '0', windowSeconds: 3600, expiresAt: EXPIRES });

async function main() {
  const out = [];
  const evidence = { drill: 'P4-LIVE', api: API, chain: CHAIN, settlementToken: TEST_USD, generatedAt: new Date().toISOString() };
  console.log(`\n== P4-LIVE (headless) against ${API} (chain ${CHAIN}) — settlement token ${TEST_USD} ==`);
  await warm();
  const owner = campaignOwner('tearapart-p4');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  console.log('owner:', owner.address, '— privy SIWE OK');
  const jobsList = async () => (await api('/api/jobs')).body?.jobs ?? [];
  const alerts = async () => (await api('/api/alerts?limit=100')).body?.alerts ?? [];
  const records = async () => (await api('/api/owner/records?limit=200')).body?.records ?? [];

  async function createAgent(name, goal, extra = {}) {
    const body = { name, goal, policy: extra.policy ?? spendIncapable(), allowlist: extra.allowlist ?? [], gatewayRules: [], ...auditKey(), ...(extra.tokenConfig ? { tokenConfig: extra.tokenConfig } : {}) };
    for (let i = 0; i < 4; i++) {
      const r = await api('/api/agents', { method: 'POST', body });
      if (r.status === 201) return { agentId: r.body.agentId, accountAddr: r.body.accountAddr };
      if (r.status < 500 && i === 0) throw new Error(`create ${name} ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
      await sleep(5000 * (i + 1));
    }
    throw new Error(`create ${name} exhausted retries`);
  }
  const link = async (a, b) => { const r = await api('/api/links', { method: 'POST', body: { fromAgentId: a, toAgentId: b, mode: 'auto' } }); if (r.status !== 201 && r.status !== 409) throw new Error(`link ${a}->${b} ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`); };

  // 1) seed job spec (F5: fee + acceptance in server state)
  const SPEC = 'eth-4000-p4live';
  const FEE = (2n * 10n ** 6n).toString(); // 2 TestUSD, 6dp
  const putSpec = await api(`/api/job-specs/${SPEC}`, { method: 'PUT', body: {
    spec: { question: 'Will ETH close above $4000 at the end of this month?', context: 'Spot ETH is ~$3,050 with ~18 days left; elevated volatility.', deliverableSchemaRef: 'market-probability@v1', acceptanceRef: 'market-analysis-floor' },
    acceptance: { label: 'market-analysis-floor', rules: [
      { kind: 'required', path: 'probability' }, { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
      { kind: 'required', path: 'rationale' }, { kind: 'stringLength', path: 'rationale', min: 1 } ] },
    feeAmountWei: FEE } });
  out.push(rec('P4-LIVE-spec-seeded', putSpec.status === 200 || putSpec.status === 201, `PUT /job-specs/${SPEC} -> ${putSpec.status}`));
  if (putSpec.status >= 300) { evidence.results = out; return finish(evidence); }

  // 2) create the ACP triangle (empirically proves the rh2 factory is token-capable)
  const feeRecipient = privateKeyToAccount(generatePrivateKey());
  const provider = await createAgent('p4-live-provider', { type: 'provider', serviceSpec: 'market probability analysis' });
  const evaluator = await createAgent('p4-live-evaluator', { type: 'evaluator', rubricRef: 'strict-calibration' });
  const requester = await createAgent('p4-live-requester',
    { type: 'requester', jobSpecSource: SPEC, providerAgentId: provider.agentId, evaluatorAgentId: evaluator.agentId, feeToken: TEST_USD, feeRecipient: feeRecipient.address, feeCapPerJobWei: (5n * 10n ** 6n).toString() },
    { allowlist: [feeRecipient.address], tokenConfig: { settlementToken: TEST_USD, perTransferCapTokenWei: (10n * 10n ** 6n).toString(), windowCapTokenWei: (20n * 10n ** 6n).toString() } });
  evidence.agents = { requester, provider, evaluator, feeRecipient: feeRecipient.address };
  out.push(rec('P4-LIVE-triangle-created', true, `requester acct ${requester.accountAddr} (token-capable factory ✓)`));

  // F6 hub: requester<->provider, requester<->evaluator
  await link(requester.agentId, provider.agentId); await link(provider.agentId, requester.agentId);
  await link(requester.agentId, evaluator.agentId); await link(evaluator.agentId, requester.agentId);
  out.push(rec('P4-LIVE-links-wired', true, 'F6 hub topology'));

  // 3) fund: mint TestUSD to requester acct + gas dust
  const mintTx = await opsWallet.sendTransaction({ to: TEST_USD, data: encodeFunctionData({ abi: ERC20, functionName: 'mint', args: [requester.accountAddr, 50n * 10n ** 6n] }) });
  await waitReceipt(mintTx);
  const bal = await pub.readContract({ address: TEST_USD, abi: ERC20, functionName: 'balanceOf', args: [requester.accountAddr] });
  const gasTx = await opsWallet.sendTransaction({ to: requester.accountAddr, value: parseEther('0.01') });
  await waitReceipt(gasTx);
  evidence.funding = { mintTx, testUsdBalance: bal.toString(), gasTx };
  out.push(rec('P4-LIVE-funded', bal >= BigInt(FEE), `requester holds ${bal} TestUSD base-units; mint ${mintTx}`));

  // 4) start the triangle → loop runs to awaiting_approval (floor + verdict passed)
  for (const a of [provider, evaluator, requester]) await api(`/api/agents/${a.agentId}/start`, { method: 'POST', body: '{}' });
  out.push(rec('P4-LIVE-started', true, 'provider/evaluator/requester started'));
  console.log('waiting for the job to reach awaiting_approval (provider deliver → floor → evaluator verdict) …');
  const awaiting = await waitUntil(1_800_000, async () => (await jobsList()).find((j) => j.status === 'awaiting_approval') ?? null, 8000);
  out.push(rec('P4-LIVE-awaiting-approval', !!awaiting, awaiting ? `job ${awaiting.jobId} awaiting_approval (floor+verdict passed)` : 'never reached awaiting_approval in 30m'));
  if (!awaiting) { evidence.results = out; return finish(evidence, provider, evaluator, requester, api); }
  evidence.awaitingJobId = awaiting.jobId;

  // 5) headless owner approve via the alerts → /api/approvals rail
  const al = await waitUntil(120_000, async () => (await alerts()).find((x) => x.refs?.approvalId && (x.kind === 'approval_required' || x.class === 'decision')) ?? null, 5000);
  out.push(rec('P4-LIVE-approval-alert', !!al, al ? `approvalId=${al.refs?.approvalId} "${(al.summary ?? '').slice(0, 70)}"` : 'no approval alert'));
  if (al?.refs?.approvalId) {
    const dec = await api(`/api/approvals/${al.refs.approvalId}`, { method: 'POST', body: { decision: 'approve', reason: 'p4-live settle approve' } });
    out.push(rec('P4-LIVE-approve-200', dec.status === 200, `POST /api/approvals/${al.refs.approvalId} approve -> ${dec.status}`));
    evidence.approvalId = al.refs.approvalId;
  }

  // 6) wait settled → verify ERC-20 transfer on-chain + recipient balance + PoA
  const settled = await waitUntil(600_000, async () => (await jobsList()).find((j) => j.jobId === awaiting.jobId && j.status === 'settled') ?? null, 6000);
  out.push(rec('P4-LIVE-settled', !!settled, settled ? `job ${settled.jobId} settled tx=${settled.settlementTx}` : 'never settled in 10m'));
  if (settled?.settlementTx) {
    const rcpt = await pub.getTransactionReceipt({ hash: settled.settlementTx }).catch(() => null);
    const recipBal = await pub.readContract({ address: TEST_USD, abi: ERC20, functionName: 'balanceOf', args: [feeRecipient.address] });
    out.push(rec('P4-LIVE-settle-receipt', rcpt?.status === 'success', `receipt.status=${rcpt?.status} block=${rcpt?.blockNumber}`));
    out.push(rec('P4-LIVE-recipient-paid', recipBal >= BigInt(FEE), `fee recipient holds ${recipBal} TestUSD (fee ${FEE})`));
    evidence.settlement = { jobId: settled.jobId, settlementTx: settled.settlementTx, receiptStatus: rcpt?.status, feeAmountWei: FEE, feeRecipient: feeRecipient.address, recipientTestUsdBalance: recipBal.toString() };
  }
  const poa = (await records()).some((r) => r.kind === 'poa');
  out.push(rec('P4-LIVE-poa-on-stream', poa, poa ? 'multi-party PoA present on owner stream' : 'no poa record (check stream pubkey)'));

  evidence.results = out;
  return finish(evidence, provider, evaluator, requester, api);
}

async function finish(evidence, ...rest) {
  const api = rest[3]; const agents = rest.slice(0, 3);
  if (api) for (const a of agents) if (a?.agentId) await api(`/api/agents/${a.agentId}/revoke`, { method: 'POST', body: '{}' }).catch(() => {});
  const fails = (evidence.results ?? []).filter((r) => !r.pass);
  const path = `${homedir()}/0g-fleet/docs/evidence/p4-live.json`;
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log(`\nP4-LIVE: ${(evidence.results ?? []).length} checks, ${fails.length} FAIL`);
  console.log('evidence →', path);
  if (fails.length) process.exitCode = 1;
}
main().catch((e) => { console.error('P4-LIVE DRILL ERROR:', e); process.exitCode = 1; });
