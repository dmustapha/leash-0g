import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../../src/jobs/gate.js';
import type { AcceptanceResult } from '../../src/jobs/acceptance.js';

const pass: AcceptanceResult = { passed: true, failures: [], checked: 3 };
const fail: AcceptanceResult = { passed: false, failures: ['missing probability'], checked: 3 };

// D-JOB-3: settlement is impossible unless (a) acceptance floor passes AND
// (b) evaluator verdict = accept AND (c) owner approves — each layer ALONE blocks.
describe('layered verification gate (D-JOB-3)', () => {
  it('releases only when all three layers pass', () => {
    expect(evaluateGate({ acceptance: pass, verdict: 'accept', owner: 'approve' })).toMatchObject({ release: true });
  });

  it('acceptance floor alone blocks (even with accept + approve)', () => {
    const r = evaluateGate({ acceptance: fail, verdict: 'accept', owner: 'approve' });
    expect(r.release).toBe(false);
    expect(r.blockedBy).toBe('acceptance');
  });

  it('evaluator reject alone blocks (even with floor pass + approve)', () => {
    const r = evaluateGate({ acceptance: pass, verdict: 'reject', owner: 'approve' });
    expect(r.release).toBe(false);
    expect(r.blockedBy).toBe('verdict');
  });

  it('owner deny alone blocks (even with floor pass + accept)', () => {
    const r = evaluateGate({ acceptance: pass, verdict: 'accept', owner: 'deny' });
    expect(r.release).toBe(false);
    expect(r.blockedBy).toBe('owner');
  });

  it('pending owner decision does not release', () => {
    expect(evaluateGate({ acceptance: pass, verdict: 'accept', owner: 'pending' }).release).toBe(false);
  });

  it('reports the FIRST failing layer (acceptance before verdict before owner)', () => {
    expect(evaluateGate({ acceptance: fail, verdict: 'reject', owner: 'deny' }).blockedBy).toBe('acceptance');
  });
});
