// E2E sweep 2026-10-04 (RH live test, D-1/D-2): the create API accepted a past
// expiresAt (minting a born-dead account) and let a zero-address allowlist reach
// the chain layer, where it surfaced as an opaque 500. Both must die at parse.
import { describe, it, expect } from 'vitest';
import { createAgentSchema } from '../../src/api/owner-routes.js';

const OWNER = '0x' + '11'.repeat(20);
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

const base = {
  name: 'hardening probe',
  auditPubKey: '04' + 'ab'.repeat(64),
  policy: {
    perTransferCapWei: '10000000000000000',
    windowCapWei: '50000000000000000',
    windowSeconds: 86_400,
    expiresAt: FUTURE,
  },
  allowlist: [OWNER],
  goal: { type: 'treasury', beneficiary: OWNER, targetBalanceWei: '100000000000000000', topUpWei: '10000000000000000' },
};

describe('createAgentSchema — input hardening (D-1/D-2)', () => {
  it('accepts the valid baseline', () => {
    expect(createAgentSchema.safeParse(base).success).toBe(true);
  });

  it('rejects expiresAt in the past (D-1)', () => {
    const r = createAgentSchema.safeParse({ ...base, policy: { ...base.policy, expiresAt: 1000 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('expiresAt must be in the future');
  });

  it('rejects expiresAt == now (boundary)', () => {
    const r = createAgentSchema.safeParse({
      ...base,
      policy: { ...base.policy, expiresAt: Math.floor(Date.now() / 1000) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects the zero address in the allowlist (D-2)', () => {
    const r = createAgentSchema.safeParse({ ...base, allowlist: ['0x' + '0'.repeat(40)] });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('zero address');
  });

  it('rejects the zero address even when buried among valid entries', () => {
    const r = createAgentSchema.safeParse({ ...base, allowlist: [OWNER, '0x' + '0'.repeat(40)] });
    expect(r.success).toBe(false);
  });
});
