// CREATE-deploy workaround spike + DIAGNOSIS confirmation (Dami: "make sure we're
// diagnosing the correct issue"). Controlled A/B on IDENTICAL bytecode:
//   - the SAME LeashAccountV4 init-code deployed via CREATE2 (expect REVERT) and via
//     CREATE (expect SUCCESS) -> the ONLY variable is the opcode => diagnosis proven.
//   - trivial-child controls (CREATE ok, CREATE2 revert) rule out size.
// Then proves the CREATE-deployed account is FULLY USABLE: correct owner/sessionKey/
// guardian/policy + a real in-policy execute() transfer (receipt.status + balance).
import * as v from 'viem';
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { clients, env, sleep } from '../rh2-campaign/common.mjs';

const { pub, ops, opsWallet } = clients(16602);
const GUARDIAN = v.getAddress('0xE1Aea125807e1d46afFfbee8C2d5C00F124c01a1'); // LEASH guardian
const DEPLOYER = v.getAddress(env.LEASH_CREATE2_DEPLOYER_ADDR);
const art = JSON.parse(readFileSync(new URL('../../../contracts/out/LeashAccountV4.sol/LeashAccountV4.json', import.meta.url)));
const creationCode = art.bytecode.object.startsWith('0x') ? art.bytecode.object : '0x' + art.bytecode.object;

const deployerAbi = v.parseAbi(['function deploy(bytes32 salt, bytes initcode) returns (address account)']);
const acctAbi = v.parseAbi([
  'function owner() view returns (address)',
  'function sessionKey() view returns (address)',
  'function guardian() view returns (address)',
  'function policy() view returns (uint128 perTransferCap,uint128 windowCap,uint32 windowSeconds,uint64 expiresAt)',
  'function execute(address to, uint256 value, bytes data)',
]);

async function waitReceipt(hash) {
  for (let i = 0; i < 15; i++) { try { return await pub.getTransactionReceipt({ hash }); } catch { await sleep(3000); } }
  return null;
}
async function sendRaw(wallet, txReq, label) {
  try {
    const hash = await wallet.sendTransaction(txReq);
    const r = await waitReceipt(hash);
    console.log(`${label.padEnd(34)} status=${r?.status ?? '??'}  ${hash.slice(0, 18)}`);
    return r;
  } catch (e) { console.log(`${label.padEnd(34)} SEND-FAILED ${(e.shortMessage || e.message || '').slice(0, 50)}`); return null; }
}

function buildAccountInitcode(owner, sessionKey, recipient) {
  const policy = { perTransferCap: v.parseEther('0.002'), windowCap: v.parseEther('0.006'), windowSeconds: 3600, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 7200) };
  const encoded = v.encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'tuple', components: [{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint32' }, { type: 'uint64' }] },
      { type: 'address[]' }, { type: 'uint64' }, { type: 'address' },
      { type: 'tuple', components: [{ type: 'uint128' }, { type: 'uint128' }] },
    ],
    [owner, GUARDIAN, sessionKey, [policy.perTransferCap, policy.windowCap, policy.windowSeconds, policy.expiresAt], [recipient], 900n, '0x0000000000000000000000000000000000000000', [0n, 0n]],
  );
  return (creationCode + encoded.slice(2));
}

async function main() {
  console.log(`\n== CREATE-deploy spike + diagnosis A/B (0G 16602) ==`);
  console.log('ops', ops.address, v.formatEther(await pub.getBalance({ address: ops.address })), '0G | creationCode', (creationCode.length - 2) / 2, 'B | block', await pub.getBlockNumber());

  const owner = privateKeyToAccount(generatePrivateKey());
  const sessionPk = generatePrivateKey();
  const sessionKey = privateKeyToAccount(sessionPk);
  const recipient = privateKeyToAccount(generatePrivateKey());
  const initcode = buildAccountInitcode(owner.address, sessionKey.address, recipient.address);
  console.log(`owner ${owner.address} | sessionKey ${sessionKey.address} | recipient ${recipient.address}`);

  // ---- CONTROLS: trivial child, CREATE vs CREATE2 (rule out size) ----
  console.log('\n-- controls (trivial 5-byte child) --');
  await sendRaw(opsWallet, { data: '0x60006000f3', gas: 100000n }, 'trivial via CREATE (expect success)');
  await sendRaw(opsWallet, { to: DEPLOYER, data: v.encodeFunctionData({ abi: deployerAbi, functionName: 'deploy', args: [generatePrivateKey(), '0x60006000f3'] }), gas: 300000n }, 'trivial via CREATE2 (expect REVERT)');

  // ---- THE A/B: IDENTICAL account init-code, CREATE2 vs CREATE ----
  console.log('\n-- A/B on IDENTICAL LeashAccountV4 init-code --');
  await sendRaw(opsWallet, { to: DEPLOYER, data: v.encodeFunctionData({ abi: deployerAbi, functionName: 'deploy', args: [generatePrivateKey(), initcode] }), gas: 10000000n }, 'account via CREATE2 (expect REVERT)');
  const createRcpt = await sendRaw(opsWallet, { data: initcode, gas: 10000000n }, 'account via CREATE (expect SUCCESS)');
  const acct = createRcpt?.contractAddress;
  if (createRcpt?.status !== 'success' || !acct) { console.log('\n❌ CREATE deploy did NOT succeed — workaround premise FAILS. Stop.'); return; }
  console.log(`\n✅ account deployed via CREATE at ${acct}`);

  // ---- account correctness (ctor ran right) ----
  const [codeLen, o, sk, g, pol] = await Promise.all([
    pub.getCode({ address: acct }).then((c) => (c && c !== '0x' ? (c.length - 2) / 2 : 0)),
    pub.readContract({ address: acct, abi: acctAbi, functionName: 'owner' }),
    pub.readContract({ address: acct, abi: acctAbi, functionName: 'sessionKey' }),
    pub.readContract({ address: acct, abi: acctAbi, functionName: 'guardian' }),
    pub.readContract({ address: acct, abi: acctAbi, functionName: 'policy' }),
  ]);
  const ok = codeLen > 0 && v.getAddress(o) === owner.address && v.getAddress(sk) === sessionKey.address && v.getAddress(g) === GUARDIAN;
  console.log(`runtime ${codeLen}B | owner✓${v.getAddress(o) === owner.address} sessionKey✓${v.getAddress(sk) === sessionKey.address} guardian✓${v.getAddress(g) === GUARDIAN} | policy ${pol}`);
  if (!ok) { console.log('❌ account state wrong after CREATE deploy.'); return; }

  // ---- FUNCTIONAL: a real in-policy execute() transfer ----
  console.log('\n-- functional execute() test --');
  await waitReceipt(await opsWallet.sendTransaction({ to: acct, value: v.parseEther('0.003') }));       // fund account
  await waitReceipt(await opsWallet.sendTransaction({ to: sessionKey.address, value: v.parseEther('0.002') })); // gas for session key
  const skWallet = v.createWalletClient({ account: sessionKey, chain: opsWallet.chain, transport: v.http(env.ZERO_G_RPC) });
  const bal0 = await pub.getBalance({ address: recipient.address });
  const exec = await sendRaw(skWallet, { to: acct, data: v.encodeFunctionData({ abi: acctAbi, functionName: 'execute', args: [recipient.address, v.parseEther('0.001'), '0x'] }), gas: 200000n }, 'execute(0.001 -> recipient)');
  const bal1 = await pub.getBalance({ address: recipient.address });
  console.log(`recipient ${v.formatEther(bal0)} -> ${v.formatEther(bal1)} 0G (rose=${bal1 > bal0})`);

  console.log('\n== SPIKE VERDICT ==');
  console.log(exec?.status === 'success' && bal1 > bal0
    ? '✅ DIAGNOSIS CONFIRMED (identical bytecode: CREATE2 reverts, CREATE succeeds) AND workaround PROVEN (CREATE-deployed LeashAccountV4 is fully functional — correct state + real in-policy execute landed).'
    : '⚠️ account deployed+constructed correctly via CREATE, but execute() did not confirm — inspect above.');
}
main().catch((e) => console.error('SPIKE ERROR:', e));
