/**
 * AQ-FND ⑥ beat-2 CORRECTION (M-3 self-funding, D-4): the earlier zero-native drill proved a
 * zero-native key can act, but the relayer just absorbed the gas — it did NOT prove the
 * SELF-FUNDING property (D-4: "LEASH never sponsors; the agent pays its own way out of its own
 * funds"). This re-run adds the GasRepayDelegate's repay leg: in ONE relayer-submitted EIP-7702
 * tx the zero-native session key (a) does a governed AQB act and (b) repays the relayer in AQB
 * for the native gas it fronted. The relayer (ops = the owner-allowlisted AQB payee) is made
 * whole in token; its only net cost is gas, covered by the agent's tokens. LEASH sponsors nothing.
 *
 *   cd /Users/MAC/leash/backend
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5433/leash' \
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) \
 *   KES=$(grep '^KEY_ENCRYPTION_SECRET=' .env | cut -d= -f2-) \
 *   npx tsx scripts/aq-fnd-step6-selffund-act.mts
 */
import { Client } from 'pg';
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildKeyring, decryptSecret } from '../src/crypto/keycrypt.js';
import { voucherDigest, type BootstrapCall } from '../src/chain/gas-planner.js';

const RPC = 'https://evmrpc-testnet.0g.ai';
const CHAIN_ID = 16602;
const chain = { id: CHAIN_ID, name: '0G Galileo', nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

const AGENT_ID = 'ff904f35-493b-4a21-a910-d18df059e567';
const ACCT = '0xe55296662581971d8cd7e26fc214b4a68d2c83ca' as Address;
const AQB = '0xec0259bc14580e81cfe87c0bdc39ca6b0bd97526' as Address;
const DELEGATE = '0xBcfA2994636D73Ea21625f83422a08B45e8c88C6' as Address;

const ACT_AQB = 1n * 10n ** 18n;        // the agent's governed act: 1 AQB to the owner payee
const REPAY_AQB = 5n * 10n ** 15n;      // 0.005 AQB repay — sized above the ~0.001-0.002 0G gas

const ACCT_ABI = parseAbi([
  'function executeTokenTransfer(address token, address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const BOOT_ABI = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function bootstrap(Call[] calls, uint256 nonce, uint256 deadline, address relayer, bytes sig)',
]);

const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
const ops = privateKeyToAccount(process.env.OPS as Hex);
const opsWallet = createWalletClient({ account: ops, chain, transport: http(RPC, { timeout: 30_000 }) });

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const row = (await db.query('select session_key_addr, session_key_enc from agents where id=$1', [AGENT_ID])).rows[0];
await db.end();
const session = privateKeyToAccount(decryptSecret(row.session_key_enc, buildKeyring({ keys: { '0': process.env.KES as string } })) as Hex);
if (session.address.toLowerCase() !== row.session_key_addr.toLowerCase()) throw new Error('session key mismatch');
const sessionWallet = createWalletClient({ account: session, chain, transport: http(RPC, { timeout: 30_000 }) });

const bal = async (who: Address) => pub.readContract({ address: AQB, abi: ERC20, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
const before = {
  sessionNative: await pub.getBalance({ address: session.address }),
  opsNative: await pub.getBalance({ address: ops.address }),
  opsAQB: await bal(ops.address),
  acctAQB: await bal(ACCT),
};
console.log('relayer =', ops.address, '(owner-allowlisted AQB payee)');
console.log('BEFORE', JSON.stringify(before, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

// One batch, executed AS the session EOA: the governed act + the gas repayment to the relayer.
const calls: BootstrapCall[] = [
  { target: ACCT, value: 0n, data: encodeFunctionData({ abi: ACCT_ABI, functionName: 'executeTokenTransfer', args: [AQB, ops.address, ACT_AQB] }) },
  { target: ACCT, value: 0n, data: encodeFunctionData({ abi: ACCT_ABI, functionName: 'executeTokenTransfer', args: [AQB, ops.address, REPAY_AQB] }) },
];
const nonce = BigInt(Date.now());
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const digest = voucherDigest(BigInt(CHAIN_ID), session.address, nonce, deadline, ops.address, calls);
const sig = await sessionWallet.signMessage({ account: session, message: { raw: digest } });
const auth = await sessionWallet.signAuthorization({ account: session, contractAddress: DELEGATE, chainId: CHAIN_ID });
const bootHash = await opsWallet.sendTransaction({
  account: ops, chain, to: session.address,
  data: encodeFunctionData({ abi: BOOT_ABI, functionName: 'bootstrap', args: [calls as any, nonce, deadline, ops.address, sig] }),
  authorizationList: [auth], type: 'eip7702',
});
console.log('relay (type-4) tx =', bootHash);
const rcpt = await pub.waitForTransactionReceipt({ hash: bootHash, timeout: 120_000 });
const gasPaidWei = rcpt.gasUsed * rcpt.effectiveGasPrice;

// Revoke the delegation (ops-relayed) so the session EOA is a plain key again.
const clearAuth = await sessionWallet.signAuthorization({ account: session, contractAddress: '0x0000000000000000000000000000000000000000', chainId: CHAIN_ID });
const clearHash = await opsWallet.sendTransaction({ account: ops, chain, to: ops.address, value: 0n, authorizationList: [clearAuth], type: 'eip7702' });
await pub.waitForTransactionReceipt({ hash: clearHash, timeout: 120_000 });

const after = {
  sessionNative: await pub.getBalance({ address: session.address }),
  opsNative: await pub.getBalance({ address: ops.address }),
  opsAQB: await bal(ops.address),
  acctAQB: await bal(ACCT),
};
console.log('AFTER', JSON.stringify(after, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

// Self-funding check: the relayer's native drop is ONLY gas; the agent's AQB repay covers it
// (1:1 notional, AQB is a mock token). The agent's account funded both the act and the gas.
const repayCoversGas = REPAY_AQB >= gasPaidWei; // 1:1 notional 0G:AQB
const opsAQBup = after.opsAQB - before.opsAQB;      // = ACT_AQB + REPAY_AQB
const acctAQBdown = before.acctAQB - after.acctAQB; // = ACT_AQB + REPAY_AQB
const pass = rcpt.status === 'success'
  && after.sessionNative === 0n
  && opsAQBup === ACT_AQB + REPAY_AQB
  && acctAQBdown === ACT_AQB + REPAY_AQB
  && repayCoversGas;
console.log(JSON.stringify({
  verdict: pass ? 'PASS' : 'FAIL',
  actTx: bootHash, clearTx: clearHash,
  gasFrontedByRelayerWei: gasPaidWei.toString(),
  gasRepaidInTokenWei: REPAY_AQB.toString(),
  repayCoversGas_1to1: repayCoversGas,
  sessionZeroNativeThroughout: before.sessionNative === 0n && after.sessionNative === 0n,
  agentTokensFundedActAndGas: acctAQBdown === ACT_AQB + REPAY_AQB,
  leashSponsored: 'nothing (relayer repaid in token; net relayer cost = gas, covered by agent AQB)',
}, null, 2));
if (!pass) process.exit(1);
