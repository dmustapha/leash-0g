import { createWalletClient, createPublicClient, http, encodeFunctionData, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
const env={}; for (const l of readFileSync('.env','utf8').split('\n')){const t=l.trim(); if(t&&!t.startsWith('#')&&t.includes('=')){const i=t.indexOf('='); env[t.slice(0,i)]=t.slice(i+1).replace(/^"|"$/g,'');}}
const RPC='https://rpc.testnet.chain.robinhood.com';
const ops=privateKeyToAccount(env.OPS_PRIVATE_KEY);
const pub=createPublicClient({transport:http(RPC)});
const w=createWalletClient({account:ops,transport:http(RPC)});
const FEED=getAddress('0x8E107bAC6f430aecB8Aa11B383E9690e9a5214bE');
const abi=parseAbi(['function setAnswer(int256)']);
const send=async(v)=>{const h=await w.sendTransaction({chain:null,to:FEED,data:encodeFunctionData({abi,functionName:'setAnswer',args:[v]}),gas:200000n});await pub.waitForTransactionReceipt({hash:h});};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for (let i=0;i<5;i++){
  await send(10_000_000_000n); // $100 — let a cycle sense
  console.log(new Date().toISOString().slice(11,19),'sensed $100, attempt',i+1);
  await sleep(22_000);
  await send(8_000_000_000n); // $80 — drop mid-cycle
  console.log(new Date().toISOString().slice(11,19),'dropped $80');
  await sleep(25_000);
}
await send(10_000_000_000n);
console.log('loop done, feed back $100');
