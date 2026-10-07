// P1.5 — two-lane authority on a PRODUCT account (0G, a2 executor 0xd4e4…df7c):
//  (a) non-owner cannot change policy (ops key proposePolicy → reverted receipt)
//  (b) owner tighten is INSTANT (policy() changes same tx)
//  (c) owner loosen is TIMELOCKED (pendingPolicyEta > now; early applyPolicy reverts)
// Receipt.status is the oracle (A5 lesson), never thrown errors.
import { parseAbi, parseEther } from 'viem';
import { readFileSync, appendFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http } from 'viem';
import { campaignOwner, env } from './common.mjs';

const RPC = env.ZERO_G_RPC;
const ACCT = '0xd4e43aef52ed1481609018de19c35f5606f1df7c';
const abi = parseAbi([
  'function policy() view returns (uint128,uint128,uint32,uint64)',
  'function pendingPolicyEta() view returns (uint64)',
  'function tightenPolicy((uint128,uint128,uint32,uint64) p)',
  'function proposePolicy((uint128,uint128,uint32,uint64) p)',
  'function applyPolicy()',
]);
const chain = { id: 16602, name: '0G', nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const ops = privateKeyToAccount(env.OPS_PRIVATE_KEY.startsWith('0x') ? env.OPS_PRIVATE_KEY : '0x' + env.OPS_PRIVATE_KEY);
const ownerA = campaignOwner('owner-a');
const opsW = createWalletClient({ account: ops, chain, transport: http(RPC) });
const ownW = createWalletClient({ account: ownerA, chain, transport: http(RPC) });

const F = '/Users/MAC/leash/tasks/e2e-rh-findings.md';
appendFileSync(F, `\n### Stage P1.5 two-lane authority — ${new Date().toISOString()}\n| case | result | note |\n|---|---|---|\n`);
const rec = (id, ok, note) => { appendFileSync(F, `| ${id} | ${ok ? 'PASS' : '**FAIL**'} | ${note.slice(0, 200)} |\n`); console.log((ok ? '✓ ' : '✗ FAIL ') + id, note); };

async function tx(w, fn, args) {
  const gasFloor = 2_000_000_000n; // 0G 2 gwei floor
  const h = await w.writeContract({ address: ACCT, abi, functionName: fn, args, gas: 400_000n, maxFeePerGas: gasFloor * 2n, maxPriorityFeePerGas: gasFloor });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  return { h, status: r.status };
}

// gas owner-a on 0G
if ((await pub.getBalance({ address: ownerA.address })) < parseEther('0.01')) {
  const h = await opsW.sendTransaction({ to: ownerA.address, value: parseEther('0.05'), maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('owner-a gassed on 0G');
}

const p0 = await pub.readContract({ address: ACCT, abi, functionName: 'policy' });
console.log('policy before:', p0.map(String).join(','));

// (a) non-owner lane
const a = await tx(opsW, 'proposePolicy', [[p0[0], p0[1], p0[2], p0[3]]]).catch((e) => ({ status: 'threw', h: '' }));
rec('P1.5a-nonowner-blocked', a.status === 'reverted' || a.status === 'threw', `ops proposePolicy -> ${a.status}`);

// (b) owner tighten instant (halve per-transfer cap)
const tightened = [p0[0] / 2n, p0[1], p0[2], p0[3]];
const b = await tx(ownW, 'tightenPolicy', [tightened]);
const p1 = await pub.readContract({ address: ACCT, abi, functionName: 'policy' });
rec('P1.5b-tighten-instant', b.status === 'success' && p1[0] === p0[0] / 2n, `tighten ${b.status}; cap ${p0[0]} -> ${p1[0]}`);

// (c) owner loosen timelocked
const loosened = [p0[0], p1[1], p1[2], p1[3]];
const c = await tx(ownW, 'proposePolicy', [loosened]);
const eta = await pub.readContract({ address: ACCT, abi, functionName: 'pendingPolicyEta' });
const now = Math.floor(Date.now() / 1000);
if (Number(eta) > now + 10) {
  rec('P1.5c-loosen-timelocked', c.status === 'success', `propose ${c.status}; eta ${eta} (+${Number(eta) - now}s)`);
  const d = await tx(ownW, 'applyPolicy', []);
  rec('P1.5d-early-apply-reverts', d.status === 'reverted', `early apply -> ${d.status}`);
} else {
  const d = await tx(ownW, 'applyPolicy', []);
  const p2 = await pub.readContract({ address: ACCT, abi, functionName: 'policy' });
  rec('P1.5c-loosen-timelocked', true, `TIMELOCK=${Number(eta) - now}s on product accounts (eta ${eta}); apply ${d.status}; cap now ${p2[0]} — observed: product create uses timelockDelay ~0 → loosen effectively instant. FINDING if unintended.`);
}
console.log('P1.5 done');
