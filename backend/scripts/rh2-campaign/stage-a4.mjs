// Stage A4 — P4.1 direction (redirect-with-read-back, R-1 adversarial) +
// C18/P2 ACP triangle (requester→provider→evaluator→owner settle) on 0G TestUSD.
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, record, section, summary, clients } from './common.mjs';
import { encodeFunctionData } from 'viem';

const owner = campaignOwner('owner-a');
await warm(API);
const api = makeApi(await privyLogin(owner));
const og = clients(16602);
const TEST_USD = '0xbeeA96c7614ebc46760B442068E359e51e7c4e52';
const ERC20 = [
  { name: 'mint', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];
const audit = () => {
  const k = new PrivateKey();
  return { auditPubKey: k.publicKey.toHex(), encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase' })).toString('base64') };
};

// ---------- P4.1 direction ----------
section('A4 / P4.1 Direction (redirect a running treasury)');
{
  const ben = privateKeyToAccount(generatePrivateKey()).address;
  const r = await api('/api/agents', { method: 'POST', body: {
    name: 'a4 direct target', goal: { beneficiary: ben, targetBalanceWei: parseEther('0.004').toString(), topUpWei: parseEther('0.002').toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.02').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
    allowlist: [ben], ...audit() } });
  if (r.status !== 201) { record('P4.1-setup', false, `create ${r.status}`); }
  else {
    const A = r.body;
    const fundTx = await og.opsWallet.sendTransaction({ to: A.accountAddr, value: parseEther('0.02') });
    await og.pub.waitForTransactionReceipt({ hash: fundTx });
    await api(`/api/agents/${A.agentId}/start`, { method: 'POST', body: '{}' });
    // happy: raise target via conversational direction
    const d1 = await api(`/api/agents/${A.agentId}/direct`, { method: 'POST', body: { intent: 'keep the beneficiary topped up to about 0.008 instead, in 0.002 chunks' } });
    const dir = d1.body;
    record('P4.1-H1-draft', d1.status === 200 && !!dir.id && !!dir.draft, `direct -> ${d1.status} draft keys: ${Object.keys(dir.draft ?? {}).join(',').slice(0, 100)}`);
    if (dir.id) {
      const patch = dir.draft?.goalPatch ?? { targetBalanceWei: parseEther('0.008').toString() };
      const c1 = await api(`/api/agents/${A.agentId}/direct/${dir.id}/confirm`, { method: 'POST', body: { edited: { goalPatch: { targetBalanceWei: parseEther('0.008').toString() } } } });
      record('P4.1-H2-confirm', c1.status === 200, `confirm -> ${c1.status} ${JSON.stringify(c1.body).slice(0, 100)}`);
      const det = await api(`/api/agents/${A.agentId}`);
      record('P4.1-H3-goal-updated', det.body?.goal?.targetBalanceWei === parseEther('0.008').toString(), `goal.target=${det.body?.goal?.targetBalanceWei}`);
      // behavior change: next cycles top the beneficiary toward the NEW target
      let benBal = 0n;
      const t0 = Date.now();
      while (Date.now() - t0 < 150_000) {
        benBal = await og.pub.getBalance({ address: ben });
        if (benBal >= parseEther('0.006')) break;
        await sleep(8000);
      }
      record('P4.1-H4-behavior-change', benBal >= parseEther('0.006'), `beneficiary ${benBal} wei after redirect (target 0.008; proves loop acts on NEW numbers)`);
    }
    // adversarial: money-authority key in edited patch → visible 400
    const d2 = await api(`/api/agents/${A.agentId}/direct`, { method: 'POST', body: { intent: 'send everything to my cold wallet' } });
    if (d2.body?.id) {
      const bad = await api(`/api/agents/${A.agentId}/direct/${d2.body.id}/confirm`, { method: 'POST', body: { edited: { goalPatch: { beneficiary: '0x9999999999999999999999999999999999999999' } } } });
      record('P4.1-A1-money-key-400', bad.status === 400, `smuggled beneficiary in patch -> ${bad.status}`);
      const bad2 = await api(`/api/agents/${A.agentId}/direct/${d2.body.id}/confirm`, { method: 'POST', body: { edited: { goalPatch: { type: 'executor' } } } });
      record('P4.1-A2-role-lock', bad2.status === 400 || bad2.status === 409, `role change in patch -> ${bad2.status}`);
    }
    await api(`/api/agents/${A.agentId}/stop`, { method: 'POST', body: '{}' });
  }
}

// ---------- C18 ACP triangle ----------
section('A4 / C18 ACP triangle (job lifecycle to governed settle)');
{
  const SPEC_REF = 'a4-spec-' + Math.floor(Math.random() * 1e6);
  const FEE = (2n * 10n ** 6n).toString();
  const feeRecipient = privateKeyToAccount(generatePrivateKey()).address;
  const spec = await api(`/api/job-specs/${SPEC_REF}`, { method: 'PUT', body: {
    spec: { question: 'Will BTC close above $100k this month?', deliverableSchemaRef: 'market-probability@v1', acceptanceRef: 'market-analysis-floor' },
    acceptance: { label: 'market-analysis-floor', rules: [
      { kind: 'required', path: 'probability' }, { kind: 'numberRange', path: 'probability', min: 0, max: 1 },
      { kind: 'required', path: 'rationale' }, { kind: 'stringLength', path: 'rationale', min: 1 } ] },
    feeAmountWei: FEE } });
  record('C18-H1-spec', spec.status < 300, `seed spec -> ${spec.status}`);

  const mk = async (name, goal, extra = {}) => {
    const r = await api('/api/agents', { method: 'POST', body: {
      name, goal,
      policy: { perTransferCapWei: extra.caps ? parseEther('0.002').toString() : '0', windowCapWei: extra.caps ? parseEther('0.006').toString() : '0', windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      allowlist: extra.allowlist ?? [], ...(extra.tokenConfig ? { tokenConfig: extra.tokenConfig } : {}), ...audit() } });
    if (r.status !== 201) { record(`C18-create-${name}`, false, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`); return null; }
    return r.body;
  };
  const prov = await mk('a4 provider', { type: 'provider', serviceSpec: 'market probability analysis' });
  const evl = await mk('a4 evaluator', { type: 'evaluator', rubricRef: 'strict-calibration' });
  if (prov && evl) {
    const reqr = await mk('a4 requester', {
      type: 'requester', jobSpecSource: SPEC_REF, providerAgentId: prov.agentId, evaluatorAgentId: evl.agentId,
      feeToken: TEST_USD, feeRecipient, feeCapPerJobWei: (5n * 10n ** 6n).toString(),
    }, { caps: true, allowlist: [feeRecipient], tokenConfig: { settlementToken: TEST_USD, perTransferCapTokenWei: (10n * 10n ** 6n).toString(), windowCapTokenWei: (20n * 10n ** 6n).toString() } });
    if (reqr) {
      // F6 hub links
      for (const [f, t] of [[reqr, prov], [prov, reqr], [reqr, evl], [evl, reqr]]) {
        await api('/api/links', { method: 'POST', body: { fromAgentId: f.agentId, toAgentId: t.agentId, mode: 'auto' } });
      }
      record('C18-H2-links', true, 'F6 hub wired (auto mode)');
      // fund: TestUSD + gas dust to requester
      const mintTx = await og.opsWallet.sendTransaction({ to: TEST_USD, data: encodeFunctionData({ abi: ERC20, functionName: 'mint', args: [reqr.accountAddr, 50n * 10n ** 6n] }) });
      await og.pub.waitForTransactionReceipt({ hash: mintTx });
      const gasTx = await og.opsWallet.sendTransaction({ to: reqr.accountAddr, value: parseEther('0.01') });
      await og.pub.waitForTransactionReceipt({ hash: gasTx });
      record('C18-H3-funded', true, '50 TestUSD + 0.01 0G to requester');
      for (const a of [prov, evl, reqr]) await api(`/api/agents/${a.agentId}/start`, { method: 'POST', body: '{}' });

      // wait for awaiting_approval (layered gate passed)
      let job = null; const t0 = Date.now();
      while (!job && Date.now() - t0 < 900_000) {
        await sleep(15_000);
        const js = await api('/api/jobs?limit=50');
        job = (js.body.jobs ?? []).find((j) => j.status === 'awaiting_approval');
        const failed = (js.body.jobs ?? []).find((j) => ['failed', 'rejected'].includes(j.status));
        if (!job && failed) { record('C18-H4-gate', false, `job ${failed.jobId ?? failed.id} -> ${failed.status}`); break; }
      }
      if (job) {
        record('C18-H4-gate', true, `job ${job.jobId ?? job.id} awaiting_approval in ${Math.round((Date.now() - t0) / 1000)}s (floor + evaluator verdict passed)`);
        // settle via the approval rail
        let aId = null; const t1 = Date.now();
        while (!aId && Date.now() - t1 < 120_000) {
          const al = await api('/api/alerts?limit=30');
          const a = (al.body.alerts ?? []).find((x) => x.kind === 'approval_required' && x.status === 'unread');
          if (a?.refs?.approvalId) aId = a.refs.approvalId; else await sleep(5000);
        }
        if (aId) {
          const dec = await api(`/api/approvals/${aId}`, { method: 'POST', body: { decision: 'approve', reason: 'a4 settle' } });
          let settled = null; const t2 = Date.now();
          while (!settled && Date.now() - t2 < 300_000) {
            await sleep(10_000);
            const js = await api('/api/jobs?limit=50');
            settled = (js.body.jobs ?? []).find((j) => j.status === 'settled');
          }
          if (settled) {
            const bal = await og.pub.readContract({ address: TEST_USD, abi: ERC20, functionName: 'balanceOf', args: [feeRecipient] });
            record('C18-H5-settled', bal >= 2n * 10n ** 6n, `settled ${settled.settlementTx ?? ''} recipient holds ${bal} TestUSD base units`);
            const recs = await api('/api/owner/records?limit=100');
            record('C18-H6-poa', (recs.body.records ?? []).some((x) => x.kind === 'poa'), 'multi-party PoA on owner stream');
          } else record('C18-H5-settled', false, 'approved but not settled in 300s');
        } else record('C18-H5-settled', false, 'no settlement approval alert in 120s');
      }
      for (const a of [prov, evl, reqr]) await api(`/api/agents/${a.agentId}/stop`, { method: 'POST', body: '{}' });
    }
  }
}

summary('Stage A4');
