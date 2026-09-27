import type { Pool } from 'pg';
import type { GrantState } from '../governed-call/index.js';
import { listGrants } from '../store/capabilities.js';
import type { RuntimeChain } from './session-chain.js';

/**
 * Stage D (D-10): build the AUTHORITATIVE `GrantState` the runtime decide-node
 * consults for a governed `call` intent. Two layers, live-chain-read discipline:
 *
 *  1. ENUMERATE — the read-model (`capability_grants`) tells us WHICH
 *     (target, selector) + candidate spenders + which tokens exist for this agent.
 *     The read-model is DISPLAY state, never authority: it only decides what to
 *     probe on-chain.
 *  2. CONFIRM — `chain.readCallGrantState` live-reads the on-chain account for the
 *     ACTUAL grant: only rules the account marks `allowed`, only spenders it
 *     allowlists, and the per-token budgets (which the read-model never stores).
 *
 * A read-model row that never applied on-chain (still `proposed`) therefore yields
 * NO rule here — so it classifies novel → JIT, never a doomed L1 submit (P3C-6).
 * With no grants the state is empty (every call is novel → JIT).
 */
export async function loadGrantState(
  pool: Pool,
  chain: RuntimeChain,
  agentId: string,
  accountAddr: string,
): Promise<GrantState> {
  const grants = await listGrants(pool, agentId); // non-removed only
  const rules = grants.map((g) => ({ target: g.target, selector: g.selector, spenders: g.spenderSet }));
  // The structured ERC-20 spend token IS the target contract (approve/transfer/…
  // debit the target's per-token budget) — probe each distinct target for a budget.
  const tokens = [...new Set(grants.map((g) => g.target.toLowerCase()))];
  return chain.readCallGrantState({ accountAddr, rules, tokens });
}
