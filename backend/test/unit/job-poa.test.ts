import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  hashJobSpec,
  verdictMessage,
  signWithSessionKey,
  recoverSigner,
  buildPoaRecord,
  verifyPoa,
} from '../../src/jobs/poa.js';
import type { JobSpec } from '../../src/jobs/envelopes.js';
import type { AcceptanceResult } from '../../src/jobs/acceptance.js';

const spec: JobSpec = { question: 'Will X?', deliverableSchemaRef: 'prob-v1', acceptanceRef: 'prob-accept-v1' };
const acceptance: AcceptanceResult = { passed: true, failures: [], checked: 4 };
const root = '0x' + 'ab'.repeat(32);
const jobId = '11111111-1111-4111-8111-111111111111';

describe('PoA multi-party signing (F7)', () => {
  it('hashJobSpec is deterministic', () => {
    expect(hashJobSpec(spec)).toBe(hashJobSpec({ ...spec }));
  });

  it('a session-key signature recovers the session-key address', async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address.toLowerCase();
    const sig = await signWithSessionKey(pk, root);
    expect(await recoverSigner(root, sig)).toBe(addr);
  });

  it('verifyPoa passes when all three parties signed their own step', async () => {
    const reqPk = generatePrivateKey();
    const provPk = generatePrivateKey();
    const evalPk = generatePrivateKey();
    const jobSpecHash = hashJobSpec(spec);

    const poa = buildPoaRecord({
      jobId,
      jobSpecHash,
      requesterSig: await signWithSessionKey(reqPk, jobSpecHash),
      deliverableRoot: root,
      providerSig: await signWithSessionKey(provPk, root),
      verdict: 'accept',
      evaluatorSig: await signWithSessionKey(evalPk, verdictMessage(jobId, 'accept', root)),
      acceptance,
      settlementTx: '0x' + 'cd'.repeat(32),
    });

    const keys = {
      requester: privateKeyToAccount(reqPk).address,
      provider: privateKeyToAccount(provPk).address,
      evaluator: privateKeyToAccount(evalPk).address,
    };
    const v = await verifyPoa(poa, keys);
    expect(v.ok).toBe(true);
    // Only structural acceptance data — no untrusted text in the record.
    expect(poa.acceptance).toEqual({ passed: true, checked: 4, failureCount: 0 });
  });

  it('verifyPoa fails when a party did not sign (forged evaluator sig)', async () => {
    const reqPk = generatePrivateKey();
    const provPk = generatePrivateKey();
    const evalPk = generatePrivateKey();
    const impostorPk = generatePrivateKey();
    const jobSpecHash = hashJobSpec(spec);

    const poa = buildPoaRecord({
      jobId,
      jobSpecHash,
      requesterSig: await signWithSessionKey(reqPk, jobSpecHash),
      deliverableRoot: root,
      providerSig: await signWithSessionKey(provPk, root),
      verdict: 'accept',
      // impostor signs the verdict instead of the real evaluator
      evaluatorSig: await signWithSessionKey(impostorPk, verdictMessage(jobId, 'accept', root)),
      acceptance,
    });

    const v = await verifyPoa(poa, {
      requester: privateKeyToAccount(reqPk).address,
      provider: privateKeyToAccount(provPk).address,
      evaluator: privateKeyToAccount(evalPk).address,
    });
    expect(v.ok).toBe(false);
    expect(v.failures).toContain('evaluator signature mismatch');
  });

  it('a verdict signature does not verify if the verdict value is swapped (binding)', async () => {
    const evalPk = generatePrivateKey();
    const sigForAccept = await signWithSessionKey(evalPk, verdictMessage(jobId, 'accept', root));
    // recovering against the 'reject' message yields a different address
    const addr = privateKeyToAccount(evalPk).address.toLowerCase();
    expect(await recoverSigner(verdictMessage(jobId, 'reject', root), sigForAccept)).not.toBe(addr);
  });
});
