/**
 * Stage F′ FP-3 — LIVE TESTNET MATRIX (FP-f). For each home chain: deploy LeashAccountV5, onboard a
 * governed-signing descriptor via the REAL `proposeSigningGrantNested` + `applySigningGrant` (using
 * the engine's `onChainGrantParams`), VERIFY the on-chain stored policy == the engine's params
 * (two-tier proof: server digest-inputs == on-chain stored values), then ARM a zero-notional intent
 * via the session key and verify ERC-1271 `isValidSignature` returns the magic value.
 *
 * Run: `npx tsx scripts/fp3-live-matrix.mts [chainKey...]` (default: all). Reads backend/.env.
 * This SPENDS real testnet gas + deploys a contract per chain — a deliberate, owner-authorized op.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, defineChain, type Hex, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defaultSigningRegistry, onChainGrantParams, buildIntent, type SigningRule } from '../src/signing/index.js';

const ERC1271_MAGIC = '0x1626ba7e';

function env(key: string): string {
  if (process.env[key]) return process.env[key] as string; // allow a one-off RPC override (flaky public RPCs)
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).replace(/^"|"$/g, '');
  }
  throw new Error(`missing ${key} in backend/.env`);
}

function loadArtifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(
    readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8'),
  ) as { abi: Abi; bytecode: { object: Hex } };
}
const artifact = loadArtifact('LeashAccountV5');
const signingLibArtifact = loadArtifact('SigningLib');
const decodeLibArtifact = loadArtifact('DecodeLib');

interface ChainSpec {
  key: string;
  name: string;
  chainId: number;
  rpcEnv: string;
  descriptorKey: string; // the Permit2 nested descriptor for this chain
  token: Hex; // budget token for the grant (nonzero; a zero-notional arm never debits it)
}

const CHAINS: ChainSpec[] = [
  { key: '0g', name: '0G Galileo', chainId: 16602, rpcEnv: 'ZERO_G_RPC', descriptorKey: 'permit2.single.0g', token: '0x000000000000000000000000000000000000dEaD' },
  { key: 'base', name: 'Base Sepolia', chainId: 84532, rpcEnv: 'BASE_SEPOLIA_RPC', descriptorKey: 'permit2.single.base', token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  { key: 'arb', name: 'Arbitrum Sepolia', chainId: 421614, rpcEnv: 'ARBITRUM_SEPOLIA_RPC', descriptorKey: 'permit2.single.arb', token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
  { key: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpcEnv: 'ETHEREUM_SEPOLIA_RPC', descriptorKey: 'permit2.single.eth', token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
];

const SPENDER = '0x1111111111111111111111111111111111111111' as Hex;

/** Poll a read until the predicate holds — handles load-balanced public RPCs (e.g. Base Sepolia) that
 * return a stale read-after-write from a lagging replica right after a tx mines. */
async function pollRead<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 15, delayMs = 2000): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

async function runChain(spec: ChainSpec): Promise<{ ok: boolean; detail: string }> {
  const rpc = env(spec.rpcEnv);
  const opsPkRaw = env('OPS_PRIVATE_KEY');
  const opsPk = (opsPkRaw.startsWith('0x') ? opsPkRaw : `0x${opsPkRaw}`) as Hex;
  const ops = privateKeyToAccount(opsPk);
  // a fresh drill session key (owner=ops, so ops drives grants; the session key drives the arm).
  const sessionPk = `0x${'5f'.repeat(32)}` as Hex;
  const session = privateKeyToAccount(sessionPk);
  const chain = defineChain({ id: spec.chainId, name: spec.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ chain, transport: http(rpc), account: ops });

  const nowSec = Math.floor(Date.now() / 1000);
  const policy = { perTransferCap: 0n, windowCap: 0n, windowSeconds: 3600, expiresAt: BigInt(nowSec + 365 * 24 * 3600) };

  // 0) deploy the FP-3 stateless helper singletons (SigningLib + DecodeLib) this account is wired to.
  const shHash = await wallet.deployContract({ abi: signingLibArtifact.abi, bytecode: signingLibArtifact.bytecode.object });
  const signingHelper = (await pub.waitForTransactionReceipt({ hash: shHash })).contractAddress;
  const dhHash = await wallet.deployContract({ abi: decodeLibArtifact.abi, bytecode: decodeLibArtifact.bytecode.object });
  const decodeHelper = (await pub.waitForTransactionReceipt({ hash: dhHash })).contractAddress;
  if (!signingHelper || !decodeHelper) throw new Error('helper deploy failed');

  // 1) deploy V5 — owner=ops, session=drill key, timelockDelay=0 (so applySigningGrant is immediate).
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [ops.address, ops.address, session.address, policy, [], 0n, spec.token, { perTransferCapToken: 0n, windowCapToken: 0n }, signingHelper, decodeHelper],
  });
  const deployRc = await pub.waitForTransactionReceipt({ hash: deployHash });
  const account = deployRc.contractAddress;
  if (!account) throw new Error('no contract address');

  const descriptor = defaultSigningRegistry.byKey(spec.descriptorKey);
  if (!descriptor) throw new Error(`no descriptor ${spec.descriptorKey}`);
  const p = onChainGrantParams(descriptor);
  const perIntentCap = 1_000_000_000_000n;
  const maxDeadlineWindow = 3600n;

  // 2) propose + apply the grant (uses the nested fn for both flat/nested; flat = zeroed fold).
  const grantParams = {
    descriptorId: BigInt(p.descriptorId),
    domainSeparator: p.domainSeparator,
    typeHash: p.typeHash,
    numTopFields: p.numFields,
    spenderLeafIndex: p.spenderIndex,
    amountLeafIndex: p.amountIndex,
    deadlineLeafIndex: p.deadlineIndex,
    expiryLeafIndex: p.expiryLeafIndex,
    nestedTypeHash: p.nestedTypeHash,
    nestedLeafStart: p.nestedLeafStart,
    nestedLeafCount: p.nestedLeafCount,
    token: spec.token,
    perIntentCap,
    maxDeadlineWindow,
  };
  const proposeHash = await wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'proposeSigningGrantNested', args: [grantParams, [SPENDER]] });
  const proposeRc = await pub.waitForTransactionReceipt({ hash: proposeHash });
  if (proposeRc.status !== 'success') throw new Error(`propose reverted (${proposeHash})`);
  // pending must be staged (eta != 0) — poll (Base's LB RPC lags read-after-write).
  const pend = await pollRead(
    () => pub.readContract({ address: account, abi: artifact.abi, functionName: 'pendingSigningGrant', args: [] }) as Promise<unknown[]>,
    (v) => BigInt((v[10] as bigint) ?? 0n) !== 0n,
  );
  if (!pend || BigInt(pend[10] as bigint) === 0n) throw new Error(`pending not staged after propose (eta=${pend?.[10]})`);
  const applyHash = await wallet.writeContract({ address: account, abi: artifact.abi, functionName: 'applySigningGrant', args: [] });
  const applyRc = await pub.waitForTransactionReceipt({ hash: applyHash });
  if (applyRc.status !== 'success') throw new Error(`apply reverted (${applyHash})`);

  // 3) TWO-TIER PROOF: on-chain stored policy == engine onChainGrantParams.
  const stored = await pollRead(
    () => pub.readContract({ address: account, abi: artifact.abi, functionName: 'signingIntentPolicy', args: [BigInt(p.descriptorId)] }) as Promise<unknown[]>,
    (v) => v[0] === true,
  );
  // tuple: [set, domainSeparator, typeHash, numFields, spenderIndex, amountIndex, deadlineIndex, token, perIntentCap, maxDeadlineWindow, nestedTypeHash, nestedLeafStart, nestedLeafCount, expiryLeafIndex]
  const assertEq = (a: unknown, b: unknown, what: string) => {
    if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error(`two-tier mismatch ${what}: on-chain ${a} != engine ${b}`);
  };
  assertEq(stored[0], true, 'set');
  assertEq(stored[1], p.domainSeparator, 'domainSeparator');
  assertEq(stored[2], p.typeHash, 'typeHash');
  assertEq(stored[3], p.numFields, 'numFields');
  assertEq(stored[4], p.spenderIndex, 'spenderIndex');
  assertEq(stored[5], p.amountIndex, 'amountIndex');
  assertEq(stored[6], p.deadlineIndex, 'deadlineIndex');
  assertEq(stored[10], p.nestedTypeHash, 'nestedTypeHash');
  assertEq(stored[11], p.nestedLeafStart, 'nestedLeafStart');
  assertEq(stored[12], p.nestedLeafCount, 'nestedLeafCount');
  assertEq(stored[13], p.expiryLeafIndex, 'expiryLeafIndex');

  // 4) ARM a zero-notional intent (amount 0 skips the budget debit) via the session key.
  const rule: SigningRule = { descriptorId: p.descriptorId, spenderSet: [SPENDER], perIntentCap: perIntentCap.toString(), maxDeadlineWindow: Number(maxDeadlineWindow), token: spec.token, active: true };
  const built = buildIntent(descriptor, rule, { amountWei: '0', spender: SPENDER, ctx: { self: account, nowSec, windowSec: 1800, pins: { nonce: 0, token: spec.token } } });
  if (!built.ok) throw new Error(`buildIntent failed: ${built.reason}`);
  // the arm MUST be submitted BY the session key (the wall checks msg.sender == sessionKey) — fund it
  // with a little gas from ops, then send from a session wallet (mirrors the runtime SessionChain).
  const fundHash = await wallet.sendTransaction({ to: session.address, value: 2_000_000_000_000_000n }); // 0.002 ETH
  await pub.waitForTransactionReceipt({ hash: fundHash });
  const sessionWallet = createWalletClient({ chain, transport: http(rpc), account: session });
  const sessionSig = await session.sign({ hash: built.digest });
  const armHash = await sessionWallet.writeContract({ address: account, abi: artifact.abi, functionName: 'authorizeSigningIntent', args: [BigInt(p.descriptorId), built.fields, sessionSig] });
  const armRc = await pub.waitForTransactionReceipt({ hash: armHash });
  if (armRc.status !== 'success') throw new Error(`arm reverted (${armHash})`);

  // 5) verify ERC-1271 recognizes the armed digest (poll — read-after-write lag on LB RPCs).
  const magic = await pollRead(
    () => pub.readContract({ address: account, abi: artifact.abi, functionName: 'isValidSignature', args: [built.digest, '0x'] }) as Promise<Hex>,
    (v) => v.toLowerCase() === ERC1271_MAGIC,
  );
  if (magic.toLowerCase() !== ERC1271_MAGIC) throw new Error(`isValidSignature != magic (got ${magic})`);

  return {
    ok: true,
    detail: `account=${account} grant=${proposeHash.slice(0, 10)}.. arm=${armHash.slice(0, 10)}.. digest=${built.digest.slice(0, 10)}.. ✅ two-tier + ERC-1271 verified`,
  };
}

const selected = process.argv.slice(2);
const chains = selected.length ? CHAINS.filter((c) => selected.includes(c.key)) : CHAINS;
const results: Record<string, string> = {};
for (const spec of chains) {
  try {
    const r = await runChain(spec);
    results[spec.name] = r.detail;
    // eslint-disable-next-line no-console
    console.log(`✅ ${spec.name}: ${r.detail}`);
  } catch (err) {
    results[spec.name] = `❌ ${err instanceof Error ? err.message : String(err)}`;
    // eslint-disable-next-line no-console
    console.log(`❌ ${spec.name}: ${results[spec.name]}`);
  }
}
// eslint-disable-next-line no-console
console.log('\n=== FP-f LIVE MATRIX SUMMARY ===');
for (const [name, detail] of Object.entries(results)) console.log(`${name}: ${detail}`);
const allOk = Object.values(results).every((d) => !d.startsWith('❌'));
process.exit(allOk ? 0 : 1);
