/**
 * AQ-FND ⑥ beat-4 LIVE act (G-6 B arm): the agent self-extends INSIDE the owner envelope with
 * ZERO owner clicks. The session key calls `agentEnableAsset` on the EnvelopeModule for a token
 * that has an envelope but no live policy; the chosen caps are within the envelope and below the
 * sharp threshold, so the module takes the INSTANT branch — `moduleSetAssetPolicy` fires in the
 * same tx, no queue, no owner signature. Driven through the same zero-native EIP-7702 bootstrap
 * as beat 2 (session EOA holds 0 native; ops relays), so this doubles as a zero-native agent act.
 *
 *   cd /Users/MAC/leash/backend
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5433/leash' \
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) \
 *   KES=$(grep '^KEY_ENCRYPTION_SECRET=' .env | cut -d= -f2-) \
 *   npx tsx scripts/aq-fnd-step6-agent-enable.mts --asset=0x.. --per=20e18 --window=80e18 --wsec=86400
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
const MODULE = '0x973b013234A896545fa96CF37d920bCd44e7189e' as Address;
const DELEGATE = '0xBcfA2994636D73Ea21625f83422a08B45e8c88C6' as Address;

const arg = (k: string, d?: string) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const e18 = (s: string) => s.endsWith('e18') ? BigInt(s.slice(0, -3)) * 10n ** 18n : BigInt(s);
const ASSET = arg('asset') as Address;
if (!ASSET) throw new Error('--asset required');
const PER = e18(arg('per', '20e18')!);
const WIN = e18(arg('window', '80e18')!);
const WSEC = Number(arg('wsec', '86400')!);

const MODULE_ABI = parseAbi([
  'function agentEnableAsset(address account, (bool enabled, uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds) p, address asset)',
  'function agentEta(address account) view returns (uint64)',
  'function envelope(address account, address asset) view returns (bool set, uint128 maxPerTransferCap, uint128 maxWindowCap, uint32 minWindowSeconds)',
  'function vetoConfig(address account) view returns (bool set, uint64 vetoDelay, uint32 sharpBps)',
]);
const ACCT_ABI = parseAbi(['function assetPolicy(address) view returns (bool enabled, uint128 perTransferCap, uint128 windowCap, uint32 windowSeconds)']);
const BOOT_ABI = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function bootstrap(Call[] calls, uint256 nonce, uint256 deadline, address relayer, bytes sig)',
]);

const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
const ops = privateKeyToAccount(process.env.OPS as Hex);
const opsWallet = createWalletClient({ account: ops, chain, transport: http(RPC, { timeout: 30_000 }) });

// Decrypt the agent's session key.
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const row = (await db.query('select session_key_addr, session_key_enc from agents where id=$1', [AGENT_ID])).rows[0];
await db.end();
const session = privateKeyToAccount(decryptSecret(row.session_key_enc, buildKeyring({ keys: { '0': process.env.KES as string } })) as Hex);
if (session.address.toLowerCase() !== row.session_key_addr.toLowerCase()) throw new Error('session key mismatch');
const sessionWallet = createWalletClient({ account: session, chain, transport: http(RPC, { timeout: 30_000 }) });

// Pre-flight the instant-branch invariants so a revert is a clear message, not a raw CallFailed.
const env = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'envelope', args: [ACCT, ASSET] }) as readonly [boolean, bigint, bigint, number];
const veto = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'vetoConfig', args: [ACCT] }) as readonly [boolean, bigint, number];
const live = await pub.readContract({ address: ACCT, abi: ACCT_ABI, functionName: 'assetPolicy', args: [ASSET] }) as readonly [boolean, bigint, bigint, number];
const withinEnv = env[0] && PER <= env[1] && WIN <= env[2] && WSEC >= env[3];
const sharp = WIN * 10_000n > env[2] * BigInt(veto[0] ? veto[2] : 0);
const widensLive = live[0] && (PER > live[1] || WIN > live[2] || WSEC < live[3]);
console.log('BEFORE', JSON.stringify({
  sessionNative: (await pub.getBalance({ address: session.address })).toString(),
  envelopeSet: env[0], vetoSet: veto[0], sharpBps: veto[2],
  livePolicyEnabled: live[0], withinEnv, sharp, widensLive, agentEta: (await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'agentEta', args: [ACCT] })).toString(),
  predictInstant: withinEnv && !sharp && !widensLive,
}, null, 2));
if (!withinEnv) throw new Error('chosen caps are outside the envelope — would revert OutsideEnvelope');

// Build the zero-native bootstrap: one call = agentEnableAsset on the module, as the session EOA.
const enableData = encodeFunctionData({ abi: MODULE_ABI, functionName: 'agentEnableAsset', args: [ACCT, { enabled: true, perTransferCap: PER, windowCap: WIN, windowSeconds: WSEC }, ASSET] });
const calls: BootstrapCall[] = [{ target: MODULE, value: 0n, data: enableData }];
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

// Revoke the delegation (ops-relayed) so the session EOA is a plain key again.
const clearAuth = await sessionWallet.signAuthorization({ account: session, contractAddress: '0x0000000000000000000000000000000000000000', chainId: CHAIN_ID });
const clearHash = await opsWallet.sendTransaction({ account: ops, chain, to: ops.address, value: 0n, authorizationList: [clearAuth], type: 'eip7702' });
await pub.waitForTransactionReceipt({ hash: clearHash, timeout: 120_000 });

const after = await pub.readContract({ address: ACCT, abi: ACCT_ABI, functionName: 'assetPolicy', args: [ASSET] }) as readonly [boolean, bigint, bigint, number];
const agentEtaAfter = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: 'agentEta', args: [ACCT] }) as bigint;
const sessionNativeAfter = await pub.getBalance({ address: session.address });
const landedInstant = after[0] && after[1] === PER && after[2] === WIN && after[3] === WSEC && agentEtaAfter === 0n;
console.log('AFTER', JSON.stringify({
  assetPolicy: { enabled: after[0], perTransfer: after[1].toString(), window: after[2].toString(), windowSeconds: after[3] },
  agentEta: agentEtaAfter.toString(), sessionNative: sessionNativeAfter.toString(),
}, null, 2));
console.log(JSON.stringify({
  verdict: rcpt.status === 'success' && landedInstant && sessionNativeAfter === 0n ? 'PASS' : 'FAIL',
  bootTx: bootHash, clearTx: clearHash,
  policyLandedInstant: landedInstant, noQueue: agentEtaAfter === 0n, noOwnerTx: true, sessionZeroNative: sessionNativeAfter === 0n,
}, null, 2));
if (!(rcpt.status === 'success' && landedInstant && sessionNativeAfter === 0n)) process.exit(1);
