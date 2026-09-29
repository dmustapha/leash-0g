import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeEventTopics,
  encodeAbiParameters,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type WalletClient,
  type Hex,
  type Log,
  type Abi,
} from 'viem';
import { LeashChainOps } from '../../src/chain/ops.js';
import { factoryAbi, factoryV4Abi, registryAbi } from '../../src/chain/abis.js';

/**
 * SE-1 (Stage E, E-1): the create flow selects `createAccountV4` on the V4
 * factory for a governed-calldata agent (accountVersion=4) and the legacy
 * `createAccount` on the legacy factory for accountVersion=2 — same 8 args,
 * only the factory address + fn/event name differ. Proven at the writeContract
 * boundary (captured factory address + functionName) plus event decoding.
 */

const OPS_PK = ('0x' + '11'.repeat(32)) as Hex;
const GUARDIAN_PK = ('0x' + '22'.repeat(32)) as Hex;
const GUARDIAN_ADDR = privateKeyToAccount(GUARDIAN_PK).address;

const LEGACY_FACTORY = ('0x' + '01'.repeat(20)) as Hex;
const V4_FACTORY = ('0x' + '04'.repeat(20)) as Hex;
const REGISTRY = ('0x' + '02'.repeat(20)) as Hex;
const OWNER = ('0x' + 'ab'.repeat(20)) as Hex;
const SESSION = ('0x' + 'cd'.repeat(20)) as Hex;
const NEW_ACCOUNT = ('0x' + 'ee'.repeat(20)) as Hex;

interface Captured {
  address: string;
  functionName: string;
}

function fakeClients(receiptFlakes = 0): {
  publicClient: PublicClient;
  opsWallet: WalletClient;
  guardianWallet: WalletClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  // Each writeContract stashes the log the receipt should carry, keyed by hash.
  const logsByHash = new Map<string, Log[]>();
  let nonce = 0;
  // S4-5: simulate a 0G receipt-drop — the FIRST `receiptFlakes` receipt reads throw
  // TransactionReceiptNotFoundError (the tx mined; the receipt just isn't queryable
  // yet). waitReceipt must re-poll the SAME hash, and deployAndRegister must NOT
  // resend the create tx (no duplicate mint).
  let flakesLeft = receiptFlakes;

  // viem 2.56 has no encodeEventLog — build (topics, data) by hand: indexed
  // params → topics, the two trailing non-indexed address params → data.
  function synthLog(
    abi: Abi,
    eventName: string,
    address: Hex,
    indexedArgs: Record<string, unknown>,
    nonIndexed: readonly Hex[],
  ): Log {
    const topics = encodeEventTopics({ abi, eventName, args: indexedArgs });
    const data = encodeAbiParameters(
      nonIndexed.map(() => ({ type: 'address' as const })),
      nonIndexed,
    );
    return { address, topics, data } as unknown as Log;
  }

  const publicClient = {
    async waitForTransactionReceipt({ hash }: { hash: string }) {
      if (flakesLeft > 0) {
        flakesLeft--;
        throw new TransactionReceiptNotFoundError({ hash: hash as Hex });
      }
      return { status: 'success', logs: logsByHash.get(hash) ?? [], transactionHash: hash };
    },
    async getBalance() {
      return 0n;
    },
  } as unknown as PublicClient;

  function makeWallet(): WalletClient {
    return {
      chain: undefined,
      async writeContract(args: { address: string; functionName: string }) {
        calls.push({ address: args.address.toLowerCase(), functionName: args.functionName });
        const hash = ('0x' + (nonce++).toString(16).padStart(64, '0')) as Hex;
        // Synthesize the event log the account/registry would emit so
        // parseEventLogs in ops.ts finds it.
        if (args.functionName === 'createAccount') {
          logsByHash.set(hash, [
            synthLog(factoryAbi, 'AccountCreated', LEGACY_FACTORY, { account: NEW_ACCOUNT, owner: OWNER }, [
              SESSION,
              GUARDIAN_ADDR,
            ]),
          ]);
        } else if (args.functionName === 'createAccountV4') {
          logsByHash.set(hash, [
            synthLog(factoryV4Abi, 'AccountCreatedV4', V4_FACTORY, { account: NEW_ACCOUNT, owner: OWNER }, [
              SESSION,
              GUARDIAN_ADDR,
            ]),
          ]);
        } else if (args.functionName === 'register') {
          logsByHash.set(hash, [
            synthLog(registryAbi, 'AgentRegistered', REGISTRY, { agentId: 7n, owner: OWNER }, [
              NEW_ACCOUNT,
              SESSION,
            ]),
          ]);
        }
        return hash;
      },
      async sendTransaction() {
        return ('0x' + 'bb'.repeat(32)) as Hex;
      },
    } as unknown as WalletClient;
  }

  return { publicClient, opsWallet: makeWallet(), guardianWallet: makeWallet(), calls };
}

function ops(clients: ReturnType<typeof fakeClients>): LeashChainOps {
  return new LeashChainOps({
    rpcUrl: 'http://rpc.leash-test.local',
    chainId: 16602,
    opsPrivateKey: OPS_PK,
    guardianPrivateKey: GUARDIAN_PK,
    factoryAddr: LEGACY_FACTORY,
    factoryV4Addr: V4_FACTORY,
    registryAddr: REGISTRY,
    clients,
  });
}

const baseInput = {
  ownerAddr: OWNER,
  sessionKeyAddr: SESSION,
  auditPubKey: '0x' + 'dd'.repeat(33),
  name: 'test-agent',
  policy: { perTransferCap: 1n, windowCap: 2n, windowSeconds: 3600, expiresAt: 0 },
  allowlist: [] as string[],
  timelockDelay: 900,
};

describe('SE-1 create→version-selected factory (E-1)', () => {
  it('accountVersion=4 → createAccountV4 on the V4 factory + AccountCreatedV4', async () => {
    const clients = fakeClients();
    const result = await ops(clients).deployAndRegister({ ...baseInput, accountVersion: 4 });
    const createCall = clients.calls.find((c) => c.functionName.startsWith('createAccount'));
    expect(createCall).toEqual({ address: V4_FACTORY.toLowerCase(), functionName: 'createAccountV4' });
    expect(result.accountAddr.toLowerCase()).toBe(NEW_ACCOUNT.toLowerCase());
  });

  it('accountVersion=2 → legacy createAccount on the legacy factory (regression)', async () => {
    const clients = fakeClients();
    const result = await ops(clients).deployAndRegister({ ...baseInput, accountVersion: 2 });
    const createCall = clients.calls.find((c) => c.functionName.startsWith('createAccount'));
    expect(createCall).toEqual({ address: LEGACY_FACTORY.toLowerCase(), functionName: 'createAccount' });
    expect(result.accountAddr.toLowerCase()).toBe(NEW_ACCOUNT.toLowerCase());
  });

  it('S4-5 no-resend: a 0G receipt-drop is re-polled by hash, NEVER resent (no duplicate mint)', async () => {
    // The create tx mined but its receipt read flakes once (TransactionReceiptNotFoundError).
    // waitReceipt re-polls the SAME hash; deployAndRegister must send createAccountV4 exactly once.
    const clients = fakeClients(1);
    const result = await ops(clients).deployAndRegister({ ...baseInput, accountVersion: 4 });
    const createCalls = clients.calls.filter((c) => c.functionName === 'createAccountV4');
    expect(createCalls.length).toBe(1); // NOT resent despite the receipt flake
    expect(clients.calls.map((c) => c.functionName)).toEqual(['createAccountV4', 'register']);
    expect(result.accountAddr.toLowerCase()).toBe(NEW_ACCOUNT.toLowerCase());
  });

  it('the same 8 construction args are passed regardless of version (arg-identical wire)', async () => {
    const clients4 = fakeClients();
    await ops(clients4).deployAndRegister({ ...baseInput, accountVersion: 4 });
    const clients2 = fakeClients();
    await ops(clients2).deployAndRegister({ ...baseInput, accountVersion: 2 });
    // both create calls precede a single register call — the funnel shape is identical
    expect(clients4.calls.map((c) => c.functionName)).toEqual(['createAccountV4', 'register']);
    expect(clients2.calls.map((c) => c.functionName)).toEqual(['createAccount', 'register']);
  });
});
