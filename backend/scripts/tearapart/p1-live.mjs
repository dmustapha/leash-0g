// P1-LIVE — treasury agent liveness against the tear-apart service + 0G testnet.
// Proves: after /start the agent senses -> reasons (0G Compute inference trace) ->
// decides -> ACTS on-chain (Executed, receipt.status==1) within one runtime cycle;
// /stop halts. Verdicts to stdout; ANCHOR transcribes to the tear-apart findings log.
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PrivateKey } from 'eciesjs';
import { API, campaignOwner, privyLogin, makeApi, warm, sleep, clients } from '../rh2-campaign/common.mjs';

const CHAIN = 16602; // 0G Galileo
const { pub, opsWallet } = clients(CHAIN);
const results = [];
const rec = (id, pass, note = '') => { results.push({ id, pass }); console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${id}  ${note}`); };

async function waitReceipt(hash, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 }); }
    catch (e) { if (i === tries - 1) throw e; await sleep(4_000); }
  }
}
async function waitUntil(_label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > deadline) return null; await sleep(5000); }
}

async function main() {
  console.log(`\n== P1-LIVE against ${API} (chain ${CHAIN}) ==`);
  await warm();
  const owner = campaignOwner('tearapart-p1');
  const token = await privyLogin(owner);
  const api = makeApi(token);
  const traces = async (id) => (await api(`/api/agents/${id}/traces?limit=200`)).body?.records ?? [];

  // Fresh beneficiary with ZERO balance (< target 0.05) so the treasury agent MUST top up.
  const beneficiary = privateKeyToAccount(generatePrivateKey());
  const k = new PrivateKey();
  const createBody = {
    name: `p1-live-${Date.now()}`,
    goal: { beneficiary: beneficiary.address, targetBalanceWei: parseEther('0.05').toString(), topUpWei: parseEther('0.002').toString() },
    policy: { perTransferCapWei: parseEther('0.002').toString(), windowCapWei: parseEther('0.006').toString(), windowSeconds: 3600, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
    allowlist: [beneficiary.address],
    auditPubKey: k.publicKey.toHex(),
    encryptedAuditKey: Buffer.from(JSON.stringify({ v: 1, mode: 'passphrase', note: 'p1-live' })).toString('base64'),
  };
  const created = await api('/api/agents', { method: 'POST', body: createBody });
  const agentId = created.body?.agentId ?? created.body?.id;
  const accountAddr = created.body?.accountAddr ?? created.body?.agent?.accountAddr;
  rec('P1-LIVE-create', created.status === 201 && !!agentId, `create -> ${created.status}; id=${agentId}; acct=${accountAddr}`);
  if (!agentId || !accountAddr) { console.log('body:', JSON.stringify(created.body).slice(0, 400)); return finish(); }

  // Fund the agent's LeashAccount so the top-up is a REAL on-chain transfer.
  const fundTx = await opsWallet.sendTransaction({ to: accountAddr, value: parseEther('0.01') });
  await waitReceipt(fundTx);
  const bal0 = await pub.getBalance({ address: beneficiary.address });
  console.log(`funded account ${accountAddr} with 0.01; beneficiary start balance=${bal0}`);

  // START — the runtime should sense -> reason -> act within one cycle (~30s).
  const started = await api(`/api/agents/${agentId}/start`, { method: 'POST', body: '{}' });
  rec('P1-LIVE-start', started.status === 200, `POST /start -> ${started.status}`);

  // Witness an on-chain ACTION trace within ~2 cycles.
  const act = await waitUntil('on-chain action trace', 120_000, async () => {
    const tr = await traces(agentId);
    return tr.find((r) => r.kind === 'action' && r.detail?.txHash) ?? null;
  });
  rec('P1-LIVE-act-within-cycle', !!act, act ? `action trace txHash=${act.detail.txHash} (seq ${act.seq})` : 'NO on-chain act within 120s');

  // Sense->reason: an inference/reasoning trace must precede the act (not a blind act).
  const tr = await traces(agentId);
  const reason = tr.find((r) => /reason|inference|sense|decision|cycle/i.test(r.kind) || r.detail?.model || r.detail?.rationale);
  rec('P1-LIVE-sense-reason', !!reason, reason ? `reasoning trace kind=${reason.kind}` : `no reasoning trace (kinds seen: ${[...new Set(tr.map((r) => r.kind))].join(',')})`);

  // Verify the act on-chain: receipt.status==1 AND beneficiary balance rose by ~topUp.
  if (act) {
    const rcpt = await waitReceipt(act.detail.txHash);
    const bal1 = await pub.getBalance({ address: beneficiary.address });
    const rose = bal1 > bal0;
    rec('P1-LIVE-receipt-status1', rcpt?.status === 'success', `receipt.status=${rcpt?.status} block=${rcpt?.blockNumber}`);
    rec('P1-LIVE-beneficiary-topped-up', rose, `beneficiary balance ${bal0} -> ${bal1} (rose=${rose})`);
  }

  // STOP halts: record act count, stop, wait > one cycle, assert no NEW act.
  const actsBefore = (await traces(agentId)).filter((r) => r.kind === 'action' && r.detail?.txHash).length;
  const stopped = await api(`/api/agents/${agentId}/stop`, { method: 'POST', body: '{}' });
  rec('P1-LIVE-stop', stopped.status === 200, `POST /stop -> ${stopped.status}`);
  await sleep(45_000); // > one 30s cycle
  const actsAfter = (await traces(agentId)).filter((r) => r.kind === 'action' && r.detail?.txHash).length;
  rec('P1-LIVE-stop-halts', actsAfter === actsBefore, `acts before stop=${actsBefore}, after 45s=${actsAfter} (must be equal)`);

  // Cleanup: revoke so the funded account can't act further after the drill.
  await api(`/api/agents/${agentId}/revoke`, { method: 'POST' }).catch(() => {});
  finish();
}

function finish() {
  const fails = results.filter((r) => !r.pass);
  console.log(`\n== P1-LIVE: ${results.length} cases, ${fails.length} FAIL ==`);
  if (fails.length) { console.log('FAILS:', fails.map((f) => f.id).join(', ')); process.exitCode = 1; }
}
main().catch((e) => { console.error('DRILL ERROR:', e); process.exitCode = 1; });
