import { decodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { parseCctpBurnMessage, type IrisClient, type IrisMessage, type CctpRailChains } from '../../src/runtime/cctp-driver.js';
import type { ReceiptStatus } from '../../src/runtime/rail-recovery.js';

/** Build a CCTP v2 burn message (148-byte header + burn body) for a given recipient/amount. */
export function burnMessage(o: { srcDomain: number; destDomain: number; nonce: number; recipient: string; amount: bigint }): Hex {
  const w = (n: bigint | number, bytes: number): string => BigInt(n).toString(16).padStart(bytes * 2, '0');
  const header = w(1, 4) + w(o.srcDomain, 4) + w(o.destDomain, 4) + w(o.nonce, 32) + '00'.repeat(32 * 3) + w(1000, 4) + w(1000, 4);
  const body = w(1, 4) + '00'.repeat(32) + o.recipient.slice(2).toLowerCase().padStart(64, '0') + w(o.amount, 32) + '00'.repeat(32 * 4);
  return `0x${header}${body}`;
}

/** The fake attestation is a function of the message, so a swapped message cannot reuse it. */
export const attestationFor = (message: Hex): Hex => keccak256(message);

/** Iris that reports `pending` for the first `pendingPolls` calls, then the configured messages. */
export class FakeIris implements IrisClient {
  polls = 0;
  constructor(private messages: Hex[], private pendingPolls = 0) {}
  async getMessages(): Promise<IrisMessage[]> {
    this.polls += 1;
    if (this.polls <= this.pendingPolls) return [];
    return this.messages.map((m) => ({ status: 'complete' as const, message: m, attestation: attestationFor(m) }));
  }
}

const RECEIVE = parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)']);

/**
 * A fake destination chain that ENFORCES the real MessageTransmitter's refusals: a bad
 * attestation reverts, and a nonce can be received only once (replay reverts). Source txs
 * confirm as scripted.
 */
export class FakeCctpChains implements CctpRailChains {
  receipts = new Map<string, ReceiptStatus>();
  usedNonces = new Set<string>();
  minted: Array<{ recipient: string; amount: bigint }> = [];
  sent: string[] = [];
  private n = 0;
  async getTxStatus(_chainId: number, txHash: string): Promise<ReceiptStatus> {
    return this.receipts.get(txHash) ?? 'pending';
  }
  async sendOpsCall(_chainId: number, _to: Address, data: Hex): Promise<string> {
    const { args } = decodeFunctionData({ abi: RECEIVE, data });
    const [message, attestation] = args as [Hex, Hex];
    const hash = `0xfill${(this.n += 1)}`;
    this.sent.push(hash);
    const nonce = `0x${message.slice(2 + 12 * 2, 2 + 44 * 2)}`;
    const ok = attestation === attestationFor(message) && !this.usedNonces.has(nonce);
    if (ok) {
      this.usedNonces.add(nonce);
      const parsed = parseCctpBurnMessage(message)!;
      this.minted.push({ recipient: parsed.mintRecipient, amount: parsed.amount });
    }
    this.receipts.set(hash, ok ? 'success' : 'reverted');
    return hash;
  }
}
