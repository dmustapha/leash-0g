import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * Stage F′ FP-4 P1 — [DEPLOY]-gated wrapper around the live deploy-path re-proof
 * (scripts/fp4-live-matrix.mts), so the proof is reproducible via the test runner.
 * Gated behind RUN_DEPLOYED_DRILL=1 (needs live 0G/Base/Arb/Eth + funds + the
 * bootstrapped singletons pinned in .env) so normal CI never runs it.
 *
 * The script is the single source of truth: it deploys a V5 account via the generic
 * Create2Deployer on every configured chain and asserts (a) deployed == off-chain
 * CREATE2 prediction, (b) RULING-B read-back (owner + both helpers == canonical),
 * (c) the SAME account address on every chain (FP-g). exit 0 ⇔ all three hold.
 */
const RUN = process.env.RUN_DEPLOYED_DRILL === '1';

(RUN ? describe : describe.skip)('FP-4 P1 deploy-path live re-proof (LIVE 4-chain)', () => {
  it('deploys V5 via Create2Deployer at one address on all chains + read-back', () => {
    const out = execFileSync('npx', ['tsx', 'scripts/fp4-live-matrix.mts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(out).toContain('identical on all chains (FP-g)');
  });
});
