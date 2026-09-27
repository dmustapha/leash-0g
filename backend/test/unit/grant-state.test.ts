import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { loadGrantState } from '../../src/runtime/grant-state.js';
import type { GrantState } from '../../src/governed-call/index.js';
import type { GrantStateCandidates, RuntimeChain } from '../../src/runtime/session-chain.js';

const TOKEN_A = '0x' + 'aa'.repeat(20);
const TOKEN_B = '0x' + 'bb'.repeat(20);
const SPENDER = '0x' + 'cc'.repeat(20);
const SELECTOR = '0x095ea7b3'; // approve

function dbRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'g1',
    agent_id: 'agent-1',
    owner_addr: '0xowner',
    target: TOKEN_A,
    selector: SELECTOR,
    recipient_mode: 'self',
    spender_set: [SPENDER],
    per_call_cap: '100',
    window_cap_call: '1000',
    codehash: null,
    source: 'preset:defi_trader',
    status: 'active',
    tx_hash: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

/** Fake pool: listGrants issues exactly one SELECT against capability_grants. */
function fakePool(rows: unknown[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

/** Fake chain: records the candidates it was asked to live-read; returns a fixed state. */
function fakeChain(state: GrantState): { chain: RuntimeChain; seen: GrantStateCandidates[] } {
  const seen: GrantStateCandidates[] = [];
  const chain = {
    async readCallGrantState(c: GrantStateCandidates) {
      seen.push(c);
      return state;
    },
  } as unknown as RuntimeChain;
  return { chain, seen };
}

const EMPTY: GrantState = { rules: new Map(), budgets: new Map(), allowlist: new Set() };

describe('loadGrantState — enumerate read-model → live-read chain', () => {
  it('passes read-model (target,selector,spenders) as candidates and dedupes tokens', async () => {
    const rows = [
      dbRow({ target: TOKEN_A, selector: SELECTOR, spender_set: [SPENDER] }),
      dbRow({ id: 'g2', target: TOKEN_A, selector: '0xa9059cbb', spender_set: [] }), // transfer, same token
      dbRow({ id: 'g3', target: TOKEN_B, selector: SELECTOR, spender_set: [SPENDER] }),
    ];
    const { chain, seen } = fakeChain(EMPTY);
    await loadGrantState(fakePool(rows), chain, 'agent-1', '0xself');

    expect(seen).toHaveLength(1);
    const c = seen[0];
    if (!c) throw new Error('expected candidates');
    expect(c.accountAddr).toBe('0xself');
    expect(c.rules).toHaveLength(3);
    expect(c.rules[0]).toEqual({ target: TOKEN_A, selector: SELECTOR, spenders: [SPENDER] });
    // distinct tokens (TOKEN_A appears twice) → deduped
    expect(c.tokens.sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });

  it('with no read-model grants asks for an empty candidate set (every call is novel → JIT)', async () => {
    const { chain, seen } = fakeChain(EMPTY);
    const state = await loadGrantState(fakePool([]), chain, 'agent-1', '0xself');
    expect(seen[0]).toEqual({ accountAddr: '0xself', rules: [], tokens: [] });
    expect(state.rules.size).toBe(0);
  });

  it('returns the chain-authoritative state verbatim (chain is the source of truth)', async () => {
    const authoritative: GrantState = {
      rules: new Map([[`${TOKEN_A}:${SELECTOR}`, {
        target: TOKEN_A, selector: SELECTOR, recipientMode: 'self', spenderSet: [SPENDER],
        perCallCap: '100', windowCapCall: '1000',
      }]]),
      budgets: new Map([[TOKEN_A, '5000']]),
      allowlist: new Set(),
    };
    const { chain } = fakeChain(authoritative);
    const state = await loadGrantState(fakePool([dbRow()]), chain, 'agent-1', '0xself');
    expect(state).toBe(authoritative);
    expect(state.budgets.get(TOKEN_A)).toBe('5000');
  });
});
