/**
 * AQ-FND ⑥ beat-2 helper: deploy a MockERC20 on 0G Galileo and mint it to the agent account
 * (simulates "fund the agent in a token, not 0G"). Ops key pays gas; the agent's SESSION key
 * is untouched (stays zero-native — the M-3 subject). Reuse a prior token with --token=0x..
 *
 *   cd /Users/MAC/leash/backend
 *   OPS=$(grep '^OPS_PRIVATE_KEY=' .env | cut -d= -f2-) npx tsx scripts/aq-fnd-step6-fund-token.mts --acct=0x.. [--token=0x..] [--name=AQP --sym=AQP --amount=1000]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://evmrpc-testnet.0g.ai';
const CHAIN_ID = 16602;
const chain = { id: CHAIN_ID, name: '0G Galileo', nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const arg = (k: string, d?: string) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const erc20 = (() => { const a = JSON.parse(readFileSync('/Users/MAC/leash/contracts/out/MockERC20.sol/MockERC20.json', 'utf8')); return { abi: a.abi, bytecode: a.bytecode.object as Hex }; })();

const acct = arg('acct') as Address;
if (!acct) throw new Error('--acct required');
const name = arg('name', 'AQFND Probe')!; const sym = arg('sym', 'AQP')!;
const amount = BigInt(arg('amount', '1000')!) * 10n ** 18n;

const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
const ops = privateKeyToAccount(process.env.OPS as Hex);
const w = createWalletClient({ account: ops, chain, transport: http(RPC, { timeout: 30_000 }) });

let token = arg('token') as Address | undefined;
if (!token) {
  const h = await w.deployContract({ abi: erc20.abi, bytecode: erc20.bytecode, args: [name, sym, 18], account: ops, chain });
  token = (await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 })).contractAddress as Address;
  console.log(`deployed ${sym} = ${token} (tx ${h})`);
}
const mh = await w.writeContract({ address: token, abi: erc20.abi, functionName: 'mint', args: [acct, amount], account: ops, chain });
await pub.waitForTransactionReceipt({ hash: mh, timeout: 120_000 });
const bal = (await pub.readContract({ address: token, abi: erc20.abi, functionName: 'balanceOf', args: [acct] })) as bigint;
const nativeAcct = await pub.getBalance({ address: acct });
console.log(JSON.stringify({ token, sym, acct, minted: amount.toString(), acctTokenBal: bal.toString(), acctNativeWei: nativeAcct.toString() }, null, 2));
