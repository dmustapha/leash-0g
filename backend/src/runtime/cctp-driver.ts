import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { RailDriver, ProofResult, ReceiptStatus } from './rail-recovery.js';
import type { RailTransferRow } from '../store/rail-transfers.js';
import { cctpDomainOfChain } from '../governed-call/rail-domains.js';

/**
 * AQ-FND M-3 inc-3b S2 — the production CCTP v2 `RailDriver`.
 *
 * The burn happens on the source chain (S1 builder, session key). This driver owns the other
 * half: fetch Circle's attestation for the burn tx, then have the OPS key submit the
 * permissionless `receiveMessage(message, attestation)` on the destination MessageTransmitterV2
 * (the burn pinned destinationCaller = 0, so anyone may fill). The ops key holds no custody and
 * cannot redirect: the mint recipient is fixed inside the signed message.
 *
 * Defence in depth: before submitting, the driver parses the attested burn message and refuses it
 * unless it is for THIS row (destination domain, mintRecipient == the agent's account, amount ==
 * the recorded amount). A burn tx can carry several messages; Iris may return any of them.
 * Forward-only: a CCTP burn is never refunded backward (`submitRefund` throws).
 */

export interface IrisMessage {
  status: 'complete' | 'pending';
  message?: string;
  attestation?: string;
}

/** Circle Iris v2 lookup of the messages emitted by one burn tx. */
export interface IrisClient {
  getMessages(srcDomain: number, srcTx: string): Promise<IrisMessage[]>;
}

/** Narrow chain surface the driver needs (implemented by LeashChainOps). */
export interface CctpRailChains {
  getTxStatus(chainId: number, txHash: string): Promise<ReceiptStatus>;
  /** broadcast `data` to `to` from the ops key on `chainId`; returns the hash WITHOUT waiting. */
  sendOpsCall(chainId: number, to: Address, data: Hex): Promise<string>;
}

export interface CctpDriverDeps {
  iris: IrisClient;
  chains: CctpRailChains;
  /** MessageTransmitterV2 on a destination chain, or null when not configured (=> refuse). */
  messageTransmitter(chainId: number): Address | null;
}

const RECEIVE_ABI = parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)']);

/** CCTP v2 message layout (bytes): header 148, then the burn body. */
const HEADER = 148;
const BODY_MINT_RECIPIENT = HEADER + 4 + 32;
const BODY_AMOUNT = HEADER + 4 + 32 + 32;
const MIN_LEN = BODY_AMOUNT + 32;

export interface ParsedBurnMessage {
  destDomain: number;
  mintRecipient: string; // 0x + 40 hex, lowercase (upper 12 bytes must be zero)
  amount: bigint;
}

const byteSlice = (hex: string, from: number, len: number): string => hex.slice(2 + from * 2, 2 + (from + len) * 2);

export function parseCctpBurnMessage(message: string): ParsedBurnMessage | null {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(message) || (message.length - 2) / 2 < MIN_LEN) return null;
  const word = byteSlice(message, BODY_MINT_RECIPIENT, 32);
  if (!/^0{24}/.test(word)) return null; // non-EVM / dirty recipient
  return {
    destDomain: parseInt(byteSlice(message, 8, 4), 16),
    mintRecipient: `0x${word.slice(24)}`.toLowerCase(),
    amount: BigInt(`0x${byteSlice(message, BODY_AMOUNT, 32)}`),
  };
}

function matchesRow(m: IrisMessage, row: RailTransferRow, destDomain: number): boolean {
  if (m.status !== 'complete' || !m.message || !m.attestation || !m.attestation.startsWith('0x')) return false;
  const p = parseCctpBurnMessage(m.message);
  return (
    p !== null &&
    p.destDomain === destDomain &&
    p.mintRecipient === row.accountAddr.toLowerCase() &&
    p.amount === BigInt(row.amountWei)
  );
}

function assertCctp(row: RailTransferRow): void {
  if (row.rail !== 'cctp') throw new Error(`cctp driver cannot drive a ${row.rail} row`);
}

export function createCctpRailDriver(deps: CctpDriverDeps): RailDriver {
  return {
    getReceiptStatus: (chainId, txHash) => deps.chains.getTxStatus(chainId, txHash),

    async fetchProof(row): Promise<ProofResult> {
      assertCctp(row);
      const srcDomain = cctpDomainOfChain(row.srcChainId);
      const destDomain = cctpDomainOfChain(row.destChainId);
      if (srcDomain === null || destDomain === null) throw new Error('cctp lane has no Circle domain');
      if (!row.srcTx) return { kind: 'pending' };
      const msgs = await deps.iris.getMessages(srcDomain, row.srcTx);
      const hit = msgs.find((m) => matchesRow(m, row, destDomain));
      return hit?.attestation && hit.message
        ? { kind: 'ready', attestation: hit.attestation, messageBytes: hit.message }
        : { kind: 'pending' };
    },

    async submitFill(row): Promise<string> {
      assertCctp(row);
      const destDomain = cctpDomainOfChain(row.destChainId);
      const transmitter = deps.messageTransmitter(row.destChainId);
      if (destDomain === null || !transmitter) throw new Error(`no MessageTransmitter configured for chain ${row.destChainId}`);
      const { messageBytes: message, attestation } = row;
      if (!message || !attestation || !matchesRow({ status: 'complete', message, attestation }, row, destDomain)) {
        throw new Error('stored attestation does not match this transfer — refusing to mint');
      }
      const data = encodeFunctionData({
        abi: RECEIVE_ABI,
        functionName: 'receiveMessage',
        args: [message as Hex, attestation as Hex],
      });
      return deps.chains.sendOpsCall(row.destChainId, transmitter, data);
    },

    async submitRefund(): Promise<string> {
      throw new Error('cctp is forward-only: a burned leg is minted forward, never refunded');
    },
  };
}

/** Circle Iris v2 over HTTP (sandbox for testnet). 404 / not-yet-indexed => no messages. */
export function createHttpIris(baseUrl: string, fetchImpl: typeof fetch = fetch): IrisClient {
  return {
    async getMessages(srcDomain, srcTx) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v2/messages/${srcDomain}?transactionHash=${srcTx}`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`iris ${res.status}`);
      const body = (await res.json()) as { messages?: Array<{ status?: string; message?: string; attestation?: string }> };
      return (body.messages ?? []).map((m) => ({
        status: m.status === 'complete' ? 'complete' : 'pending',
        ...(m.message ? { message: m.message } : {}),
        ...(m.attestation ? { attestation: m.attestation } : {}),
      }));
    },
  };
}
