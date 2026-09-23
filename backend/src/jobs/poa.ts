import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, recoverMessageAddress, toHex, type Hex } from 'viem';
import { canonicalJson, type Json } from '../crypto/canonical.js';
import type { JobSpec } from './envelopes.js';
import type { AcceptanceResult } from './acceptance.js';

/**
 * Proof-of-Agreement (spec §3c, F7) — a genuinely MULTI-PARTY signed artifact.
 * Each ACP party cryptographically attests its OWN step with its session key:
 *   - requester signs the job spec hash
 *   - provider signs the deliverable root
 *   - evaluator signs (jobId | verdict | deliverableRoot)
 * The assembled record is appended to the owner-record/audit stream (hash-chained
 * → 0G Storage). This reproduces ACP's *signed* Proof of Agreement WITHOUT
 * holding escrow. Only hashes/roots/sigs live in the verified record — the
 * untrusted deliverable/rationale TEXT never enters it (F-quar / L-1).
 */

/** keccak256 over the canonical JSON of the owner-seeded job spec. */
export function hashJobSpec(spec: JobSpec): Hex {
  return keccak256(toHex(canonicalJson(spec as unknown as Json)));
}

/** The exact message the evaluator signs (binds verdict to job + deliverable). */
export function verdictMessage(jobId: string, verdict: 'accept' | 'reject', deliverableRoot: string): string {
  return `leash-verdict|${jobId}|${verdict}|${deliverableRoot}`;
}

/** Sign an artifact with a session key (EOA). Returns a 0x signature. */
export async function signWithSessionKey(sessionPrivateKey: string, message: string): Promise<Hex> {
  const account = privateKeyToAccount(sessionPrivateKey as Hex);
  return account.signMessage({ message });
}

/** Recover the signer address of a message (lowercased). */
export async function recoverSigner(message: string, signature: string): Promise<string> {
  const addr = await recoverMessageAddress({ message, signature: signature as Hex });
  return addr.toLowerCase();
}

export interface PoaRecord {
  jobId: string;
  jobSpecHash: string;
  requesterSig: string;
  deliverableRoot: string;
  providerSig: string;
  verdict: 'accept' | 'reject';
  evaluatorSig: string;
  /** Structural floor result — booleans/counts only, no untrusted text. */
  acceptance: { passed: boolean; checked: number; failureCount: number };
  /** The governed settlement tx hash (present only when released). */
  settlementTx?: string;
}

export function buildPoaRecord(input: {
  jobId: string;
  jobSpecHash: string;
  requesterSig: string;
  deliverableRoot: string;
  providerSig: string;
  verdict: 'accept' | 'reject';
  evaluatorSig: string;
  acceptance: AcceptanceResult;
  settlementTx?: string;
}): PoaRecord {
  return {
    jobId: input.jobId,
    jobSpecHash: input.jobSpecHash,
    requesterSig: input.requesterSig,
    deliverableRoot: input.deliverableRoot,
    providerSig: input.providerSig,
    verdict: input.verdict,
    evaluatorSig: input.evaluatorSig,
    // Only the STRUCTURAL result — never the failure strings (they can echo
    // untrusted deliverable content) into the verified, permanent record.
    acceptance: { passed: input.acceptance.passed, checked: input.acceptance.checked, failureCount: input.acceptance.failures.length },
    ...(input.settlementTx !== undefined ? { settlementTx: input.settlementTx } : {}),
  };
}

/**
 * Verify all three party signatures against their expected session-key
 * addresses. Returns which (if any) failed — used by the master review / a
 * third party re-verifying the PoA from 0G Storage.
 */
export async function verifyPoa(
  poa: PoaRecord,
  keys: { requester: string; provider: string; evaluator: string },
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  const requester = await recoverSigner(poa.jobSpecHash, poa.requesterSig).catch(() => 'invalid');
  if (requester !== keys.requester.toLowerCase()) failures.push('requester signature mismatch');
  const provider = await recoverSigner(poa.deliverableRoot, poa.providerSig).catch(() => 'invalid');
  if (provider !== keys.provider.toLowerCase()) failures.push('provider signature mismatch');
  const evaluator = await recoverSigner(
    verdictMessage(poa.jobId, poa.verdict, poa.deliverableRoot),
    poa.evaluatorSig,
  ).catch(() => 'invalid');
  if (evaluator !== keys.evaluator.toLowerCase()) failures.push('evaluator signature mismatch');
  return { ok: failures.length === 0, failures };
}
