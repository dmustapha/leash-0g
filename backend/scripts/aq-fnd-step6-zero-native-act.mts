/**
 * AQ-FND ⑥ beat-2 LIVE act (M-3): the canonical agent's session key moves a token with the
 * EIP-7702 GasRepayDelegate path while LEASH sponsors nothing. To make the zero-native property
 * UNIMPEACHABLE on a live session key the runtime pre-funded (0.002 0G), the relayer-submitted
 * bootstrap batch is TWO calls, executed atomically AS the session EOA:
 *   (0) drain the session EOA's entire native balance to ops  → EOA ends at 0 native
 *   (1) executeTokenTransfer(AQB, owner, amount) through the account's governed wall
 * The outer type-4 tx gas is paid by ops (the relayer); the session EOA needs no native at all.
 * After the batch: session native == 0, account native == 0, AQB moved to the owner — a governed
 * token spend by a session key holding ZERO native coin, proven live.
 *
 *   cd /Users/MAC/leash/backend
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5433/leash' \
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) \
 *   KES=$(grep '^KEY_ENCRYPTION_SECRET=' .env | cut -d= -f2-) \
 *   npx tsx scripts/aq-fnd-step6-zero-native-act.mts
 */
import { Client } from 'pg';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi,
  type Address, type Hex,
} from 'viem';
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
const OWNER = '0xc211C942946011859ca634F22400d80570ED12A5' as Address;
const AMOUNT = 5n * 10n ** 18n; // 5 AQB — within the 100 AQB/24h budget just set

const ACCT_ABI = parseAbi(['function executeTokenTransfer(address token, address to, uint256 amount)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const BOOT_ABI = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function bootstrap(Call[] calls, uint256 nonce, uint256 deadline, address relayer, bytes sig)',
]);

const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
const ops = privateKeyToAccount(process.env.OPS as Hex);
const opsWallet = createWalletClient({ account: ops, chain, transport: http(RPC, { timeout: 30_000 }) });

// 1) Decrypt the agent's scoped session key from the DB (legacy blob → KEK id '0').
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const row = (await db.query('select session_key_addr, session_key_enc from agents where id=$1', [AGENT_ID])).rows[0];
await db.end();
const keyring = buildKeyring({ keys: { '0': process.env.KES as string } });
const sessionPk = decryptSecret(row.session_key_enc, keyring) as Hex;
const session = privateKeyToAccount(sessionPk);
if (session.address.toLowerCase() !== row.session_key_addr.toLowerCase()) {
  throw new Error(`decrypted key ${session.address} != recorded ${row.session_key_addr}`);
}
const sessionWallet = createWalletClient({ account: session, chain, transport: http(RPC, { timeout: 30_000 }) });

// 2) Snapshot before.
const before = {
  sessionNative: await pub.getBalance({ address: session.address }),
  acctNative: await pub.getBalance({ address: ACCT }),
  acctAQB: await pub.readContract({ address: AQB, abi: ERC20, functionName: 'balanceOf', args: [ACCT] }) as bigint,
  ownerAQB: await pub.readContract({ address: AQB, abi: ERC20, functionName: 'balanceOf', args: [OWNER] }) as bigint,
  opsNative: await pub.getBalance({ address: ops.address }),
};
console.log('session key =', session.address);
console.log('BEFORE', JSON.stringify({ ...before }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

// 3) Build the two-call batch: drain session native → ops, then the governed AQB transfer.
const calls: BootstrapCall[] = [
  { target: ops.address, value: before.sessionNative, data: '0x' },
  { target: ACCT, value: 0n, data: encodeFunctionData({ abi: ACCT_ABI, functionName: 'executeTokenTransfer', args: [AQB, OWNER, AMOUNT] }) },
];

// 4) Voucher + chain-pinned 7702 authorization, both signed by the SESSION key itself.
const nonce = BigInt(Date.now());
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const digest = voucherDigest(BigInt(CHAIN_ID), session.address, nonce, deadline, ops.address, calls);
const sig = await sessionWallet.signMessage({ account: session, message: { raw: digest } });
const auth = await sessionWallet.signAuthorization({ account: session, contractAddress: DELEGATE, chainId: CHAIN_ID });

// 5) Ops relays the single type-4 transaction. Ops pays ALL gas; the session EOA pays nothing.
const bootHash = await opsWallet.sendTransaction({
  account: ops, chain, to: session.address,
  data: encodeFunctionData({ abi: BOOT_ABI, functionName: 'bootstrap', args: [calls as any, nonce, deadline, ops.address, sig] }),
  authorizationList: [auth], type: 'eip7702',
});
console.log('relay (type-4) tx =', bootHash);
const rcpt = await pub.waitForTransactionReceipt({ hash: bootHash, timeout: 120_000 });

// 6) Revoke the 7702 delegation (ops-relayed) so the session EOA is a plain key again.
const clearAuth = await sessionWallet.signAuthorization({ account: session, contractAddress: '0x0000000000000000000000000000000000000000', chainId: CHAIN_ID });
const clearHash = await opsWallet.sendTransaction({ account: ops, chain, to: ops.address, value: 0n, authorizationList: [clearAuth], type: 'eip7702' });
await pub.waitForTransactionReceipt({ hash: clearHash, timeout: 120_000 });

// 7) Snapshot after.
const after = {
  sessionNative: await pub.getBalance({ address: session.address }),
  acctNative: await pub.getBalance({ address: ACCT }),
  acctAQB: await pub.readContract({ address: AQB, abi: ERC20, functionName: 'balanceOf', args: [ACCT] }) as bigint,
  ownerAQB: await pub.readContract({ address: AQB, abi: ERC20, functionName: 'balanceOf', args: [OWNER] }) as bigint,
  sessionCode: await pub.getCode({ address: session.address }),
};
console.log('AFTER', JSON.stringify({ ...after }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

const movedAQB = after.ownerAQB - before.ownerAQB;
const pass = rcpt.status === 'success'
  && after.sessionNative === 0n
  && after.acctNative === 0n
  && movedAQB === AMOUNT
  && (!after.sessionCode || after.sessionCode === '0x');
console.log(JSON.stringify({
  verdict: pass ? 'PASS' : 'FAIL',
  bootTx: bootHash, clearTx: clearHash,
  sessionNativeEndedZero: after.sessionNative === 0n,
  accountNativeZero: after.acctNative === 0n,
  aqbMovedToOwner: movedAQB.toString(),
  delegationCleared: !after.sessionCode || after.sessionCode === '0x',
}, null, 2));
if (!pass) process.exit(1);
