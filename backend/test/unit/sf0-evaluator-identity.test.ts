import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  assertEvaluatorIdentity,
  verifyPoa,
  buildPoaRecord,
  verdictMessage,
  signWithSessionKey,
  type PoaRecord,
} from '../../src/jobs/poa.js';

/**
 * SF-0 / L-01 unit floor. The gate that closes L-01 is driven end-to-end in
 * test/integration/sf0-verdict-gate-verify.test.ts; here we pin the two pure
 * primitives it rests on: the sender-identity assertion (F-0b) and verifyPoa's
 * evaluator-signature recovery (F-0a), which was defined but never called on the
 * live verdict→approval path before this slice.
 */

const REQ_PK = ('0x' + '11'.repeat(32)) as Hex;
const PROV_PK = ('0x' + '22'.repeat(32)) as Hex;
const EVAL_PK = ('0x' + '33'.repeat(32)) as Hex;
const ATTACKER_PK = ('0x' + '44'.repeat(32)) as Hex;

const req = privateKeyToAccount(REQ_PK).address.toLowerCase();
const prov = privateKeyToAccount(PROV_PK).address.toLowerCase();
const evalr = privateKeyToAccount(EVAL_PK).address.toLowerCase();

const JOB_ID = 'job-sf0-unit';
const JOB_SPEC_HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const DELIVERABLE_ROOT = ('0x' + 'cd'.repeat(32)) as Hex;

async function assemblePoa(evaluatorSig: string, verdict: 'accept' | 'reject' = 'accept'): Promise<PoaRecord> {
  const requesterSig = await signWithSessionKey(REQ_PK, JOB_SPEC_HASH);
  const providerSig = await signWithSessionKey(PROV_PK, DELIVERABLE_ROOT);
  return buildPoaRecord({
    jobId: JOB_ID,
    jobSpecHash: JOB_SPEC_HASH,
    requesterSig,
    deliverableRoot: DELIVERABLE_ROOT,
    providerSig,
    verdict,
    evaluatorSig,
    acceptance: { passed: true, failures: [], checked: 3 },
  });
}

const KEYS = { requester: req, provider: prov, evaluator: evalr };

describe('SF-0 assertEvaluatorIdentity (F-0b)', () => {
  const job = { evaluatorAgentId: 'eval-agent-1' };

  it('accepts a verdict from the bound evaluator', () => {
    expect(assertEvaluatorIdentity('eval-agent-1', job)).toBe(true);
  });

  it('refuses a verdict from any other agent (same-owner impersonation)', () => {
    expect(assertEvaluatorIdentity('provider-agent-7', job)).toBe(false);
    expect(assertEvaluatorIdentity('requester-agent-9', job)).toBe(false);
  });

  it('fails closed on an absent sender', () => {
    expect(assertEvaluatorIdentity(undefined, job)).toBe(false);
    expect(assertEvaluatorIdentity(null, job)).toBe(false);
    expect(assertEvaluatorIdentity('', job)).toBe(false);
  });
});

describe('SF-0 verifyPoa evaluator-signature recovery (F-0a)', () => {
  it('passes a genuine evaluator signature over (jobId|verdict|deliverableRoot)', async () => {
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(JOB_ID, 'accept', DELIVERABLE_ROOT));
    const poa = await assemblePoa(sig, 'accept');
    expect(await verifyPoa(poa, KEYS)).toEqual({ ok: true, failures: [] });
  });

  it('refuses a forged signature from a non-party key', async () => {
    const sig = await signWithSessionKey(ATTACKER_PK, verdictMessage(JOB_ID, 'accept', DELIVERABLE_ROOT));
    const poa = await assemblePoa(sig, 'accept');
    const r = await verifyPoa(poa, KEYS);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('evaluator signature mismatch');
  });

  it('refuses a wrong-signer signature (signed by the provider key)', async () => {
    const sig = await signWithSessionKey(PROV_PK, verdictMessage(JOB_ID, 'accept', DELIVERABLE_ROOT));
    const poa = await assemblePoa(sig, 'accept');
    expect((await verifyPoa(poa, KEYS)).ok).toBe(false);
  });

  it('refuses a garbage / unrecoverable signature', async () => {
    const poa = await assemblePoa('0x' + 'ff'.repeat(65), 'accept');
    expect((await verifyPoa(poa, KEYS)).ok).toBe(false);
  });

  it('refuses a verdict signed over a DIFFERENT verdict value (payload tamper)', async () => {
    // evaluator genuinely signed 'reject', payload claims 'accept'
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage(JOB_ID, 'reject', DELIVERABLE_ROOT));
    const poa = await assemblePoa(sig, 'accept');
    expect((await verifyPoa(poa, KEYS)).ok).toBe(false);
  });

  it('refuses a cross-job replayed signature (bound to a different jobId)', async () => {
    const sig = await signWithSessionKey(EVAL_PK, verdictMessage('some-other-job', 'accept', DELIVERABLE_ROOT));
    const poa = await assemblePoa(sig, 'accept');
    expect((await verifyPoa(poa, KEYS)).ok).toBe(false);
  });
});
