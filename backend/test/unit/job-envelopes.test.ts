import { describe, it, expect } from 'vitest';
import { parseJobPayload, isJobKind, jobSpecSchema, JOB_KINDS } from '../../src/jobs/envelopes.js';

// The 4 ACP envelope kinds are UNTRUSTED and strict-validated before use (F4).
const jobId = '11111111-1111-4111-8111-111111111111';
const root = '0x' + 'ab'.repeat(32);
const addr = '0x' + '12'.repeat(20);

describe('job envelope parsing', () => {
  it('recognizes exactly the four job kinds', () => {
    expect(JOB_KINDS).toEqual(['job.request', 'job.deliver', 'job.evaluate', 'job.verdict']);
    expect(isJobKind('job.request')).toBe(true);
    expect(isJobKind('transfer.request')).toBe(false);
  });

  it('parses a valid job.request', () => {
    const p = parseJobPayload('job.request', {
      jobId,
      spec: { question: 'Will X happen?', deliverableSchemaRef: 'prob-v1', acceptanceRef: 'prob-accept-v1' },
      feeToken: addr,
      feeAmountWei: '1000000',
      deadlineUnix: 1_800_000_000,
    });
    expect(p?.kind).toBe('job.request');
  });

  it('rejects job.request with unknown extra keys (strict)', () => {
    const p = parseJobPayload('job.request', {
      jobId,
      spec: { question: 'q', deliverableSchemaRef: 'r', acceptanceRef: 'a' },
      feeToken: addr,
      feeAmountWei: '1000000',
      deadlineUnix: 1_800_000_000,
      injectedFee: '99999999', // attacker extra field
    });
    expect(p).toBeNull();
  });

  it('rejects job.deliver with a malformed root', () => {
    expect(
      parseJobPayload('job.deliver', {
        jobId,
        deliverableRoot: '0xnothex',
        deliverableSummary: 'done',
        providerSig: 'sig',
      }),
    ).toBeNull();
  });

  it('parses valid job.deliver / job.evaluate / job.verdict', () => {
    expect(parseJobPayload('job.deliver', { jobId, deliverableRoot: root, deliverableSummary: 'ok', providerSig: 's' })?.kind).toBe('job.deliver');
    expect(parseJobPayload('job.evaluate', { jobId, deliverableRoot: root, jobSpecHash: root })?.kind).toBe('job.evaluate');
    expect(parseJobPayload('job.verdict', { jobId, verdict: 'accept', rationaleRef: root, evaluatorSig: 's' })?.kind).toBe('job.verdict');
  });

  it('rejects an unknown verdict value', () => {
    expect(parseJobPayload('job.verdict', { jobId, verdict: 'maybe', rationaleRef: root, evaluatorSig: 's' })).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(parseJobPayload('job.frobnicate', {})).toBeNull();
  });

  it('jobSpec rejects extra keys', () => {
    expect(jobSpecSchema.safeParse({ question: 'q', deliverableSchemaRef: 'r', acceptanceRef: 'a', sneaky: 1 }).success).toBe(false);
  });
});
