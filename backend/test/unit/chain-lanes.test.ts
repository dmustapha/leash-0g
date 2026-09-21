import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient, WalletClient } from 'viem';
import { LeashChainOps } from '../../src/chain/ops.js';

/**
 * C-1 lane independence (D6): the guardian key is a SEPARATE signer with its
 * own serialized lane — a revoke fired during a create burst must confirm
 * without queuing behind any create tx. Proven here by saturating the ops
 * lane with never-resolving creates and asserting the guardian revoke still
 * completes. Plus C-2: a reverted receipt must reject, never resolve ok.
 */

const OPS_PK = ('0x' + '11'.repeat(32)) as `0x${string}`;
const GUARDIAN_PK = ('0x' + '22'.repeat(32)) as `0x${string}`;
const GUARDIAN_ADDR = privateKeyToAccount(GUARDIAN_PK).address;
const OPS_ADDR = privateKeyToAccount(OPS_PK).address;

interface FakeClients {
  publicClient: PublicClient;
  opsWallet: WalletClient;
  guardianWallet: WalletClient;
  opsCalls: string[];
  guardianCalls: string[];
}

function fakeClients(opts: { opsHangs?: boolean; receiptStatus?: 'success' | 'reverted' } = {}): FakeClients {
  const opsCalls: string[] = [];
  const guardianCalls: string[] = [];
  const publicClient = {
    async waitForTransactionReceipt({ hash }: { hash: string }) {
      return { status: opts.receiptStatus ?? 'success', logs: [], transactionHash: hash };
    },
    async getBalance() {
      return 0n;
    },
  } as unknown as PublicClient;
  const opsWallet = {
    chain: undefined,
    async writeContract(args: { functionName: string }) {
      opsCalls.push(args.functionName);
      if (opts.opsHangs) return new Promise<never>(() => undefined); // saturated lane: never confirms
      return '0x' + 'aa'.repeat(32);
    },
    async sendTransaction() {
      return '0x' + 'bb'.repeat(32);
    },
  } as unknown as WalletClient;
  const guardianWallet = {
    chain: undefined,
    async writeContract(args: { functionName: string }) {
      guardianCalls.push(args.functionName);
      return '0x' + 'cc'.repeat(32);
    },
    async sendTransaction() {
      throw new Error('guardian lane must never send funds');
    },
  } as unknown as WalletClient;
  return { publicClient, opsWallet, guardianWallet, opsCalls, guardianCalls };
}

function ops(clients: FakeClients): LeashChainOps {
  return new LeashChainOps({
    rpcUrl: 'http://rpc.leash-test.local',
    chainId: 16602,
    opsPrivateKey: OPS_PK,
    guardianPrivateKey: GUARDIAN_PK,
    factoryAddr: '0x' + '01'.repeat(20),
    registryAddr: '0x' + '02'.repeat(20),
    clients,
  });
}

describe('C-1 guardian lane independence', () => {
  it('a revoke confirms while the deployer lane is saturated with hung creates', async () => {
    const clients = fakeClients({ opsHangs: true });
    const chain = ops(clients);

    // Saturate the ops lane: creates that never confirm (do not await).
    const burst = Array.from({ length: 3 }, () =>
      chain
        .deployAndRegister({
          ownerAddr: '0x' + '5a'.repeat(20),
          sessionKeyAddr: '0x' + '5b'.repeat(20),
          auditPubKey: '04' + 'cd'.repeat(64),
          name: 'burst',
          policy: { perTransferCap: 1n, windowCap: 1n, windowSeconds: 60, expiresAt: 2 ** 31 },
          allowlist: [],
          timelockDelay: 900,
        })
        .catch(() => undefined),
    );
    void burst;

    // Guardian-lane revoke (account created with the guardian key) resolves
    // even though every ops-lane tx is still pending.
    const result = await Promise.race([
      chain.revoke('0x' + '03'.repeat(20), GUARDIAN_ADDR),
      new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 500)),
    ]);
    expect(result).not.toBe('stuck');
    expect((result as { txHash: string }).txHash).toBeDefined();
    expect(clients.guardianCalls).toEqual(['revoke']);
    // The revoke never touched the ops signer.
    expect(clients.opsCalls.filter((c) => c === 'revoke')).toHaveLength(0);
  });

  it('legacy accounts (ops-key guardian) revoke through the ops lane', async () => {
    const clients = fakeClients();
    const chain = ops(clients);
    await chain.revoke('0x' + '03'.repeat(20), OPS_ADDR);
    expect(clients.opsCalls).toEqual(['revoke']);
    expect(clients.guardianCalls).toHaveLength(0);
  });

  it('null guardian (pre-backfill legacy row) falls back to the ops lane', async () => {
    const clients = fakeClients();
    const chain = ops(clients);
    await chain.revoke('0x' + '03'.repeat(20), null);
    expect(clients.opsCalls).toEqual(['revoke']);
  });

  it('new accounts are created with the guardian key as guardian', async () => {
    const clients = fakeClients();
    const chain = ops(clients);
    // deployAndRegister parses logs; our fake receipt has none → it throws,
    // but the guardian arg is captured before that via writeContract args.
    let guardianArg: string | undefined;
    (clients.opsWallet as unknown as { writeContract: (a: { args?: unknown[]; functionName: string }) => Promise<string> }).writeContract =
      async (args) => {
        if (args.functionName === 'createAccount') guardianArg = (args.args as string[])[1];
        return '0x' + 'aa'.repeat(32);
      };
    await chain
      .deployAndRegister({
        ownerAddr: '0x' + '5a'.repeat(20),
        sessionKeyAddr: '0x' + '5b'.repeat(20),
        auditPubKey: '04' + 'cd'.repeat(64),
        name: 'x',
        policy: { perTransferCap: 1n, windowCap: 1n, windowSeconds: 60, expiresAt: 2 ** 31 },
        allowlist: [],
        timelockDelay: 900,
      })
      .catch(() => undefined);
    expect(guardianArg).toBe(GUARDIAN_ADDR);
  });
});

describe('C-2 revoke receipt guard', () => {
  it('a reverted revoke receipt rejects — never resolves ok', async () => {
    const clients = fakeClients({ receiptStatus: 'reverted' });
    const chain = ops(clients);
    await expect(chain.revoke('0x' + '03'.repeat(20), GUARDIAN_ADDR)).rejects.toThrow(/reverted/);
  });
});
