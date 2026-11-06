import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import {
  initiateRailTransfer,
  recordSourceSubmitted,
  getRailTransfer,
  UnfundedRouteError,
  type DestGasPlan,
  type RailTransferRow,
} from '../../src/store/rail-transfers.js';
import {
  sweepRailRecovery,
  type RailDriver,
  type ReceiptStatus,
  type ProofResult,
} from '../../src/runtime/rail-recovery.js';

/**
 * AQ-FND M-4 — the cross-chain rail recovery state machine. Proves the no-fill →
 * refund → retry machine is first-class typed state: a programmable fake driver
 * supplies receipt/proof/fill/refund outcomes, and we assert the row advances
 * exactly as the lifecycle promises (and never double-submits, via the CAS).
 */

const AGENT = 'agent-rail-1';
const ACCOUNT = '0x' + 'c2'.repeat(20);
const USDC = '0x' + 'a1'.repeat(20);

// Windows below use -60_000 ("already elapsed") rather than 0: the DB clock (docker VM) can run tens of ms
// ahead of the test process, so an age of `JS now - DB now()` is slightly NEGATIVE and a 0 window never fires.
const gasPlan = (destChainId: number): DestGasPlan => ({ destChainId, fundedWei: '1000000000000000', source: 'prefunded' });

/** A fully programmable RailDriver: each method reads a script keyed by railId. */
class FakeDriver implements RailDriver {
  receipts: Record<string, ReceiptStatus> = {};
  proofs: Record<string, ProofResult> = {};
  fillHashes: Record<string, string> = {};
  refundHashes: Record<string, string> = {};
  fillShouldThrow = new Set<string>();
  submittedFills: string[] = [];
  submittedRefunds: string[] = [];

  async getReceiptStatus(_chainId: number, txHash: string): Promise<ReceiptStatus> {
    return this.receipts[txHash] ?? 'pending';
  }
  async fetchProof(row: RailTransferRow): Promise<ProofResult> {
    return this.proofs[row.railId] ?? { kind: 'pending' };
  }
  async submitFill(row: RailTransferRow): Promise<string> {
    this.submittedFills.push(row.railId);
    if (this.fillShouldThrow.has(row.railId)) throw new Error('mint failed');
    return this.fillHashes[row.railId] ?? `0xdest-${row.railId}`;
  }
  async submitRefund(row: RailTransferRow): Promise<string> {
    this.submittedRefunds.push(row.railId);
    return this.refundHashes[row.railId] ?? `0xrefund-${row.railId}`;
  }
}

describe('rail recovery state machine (AQ-FND M-4)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('DELETE FROM rail_transfers');
  });

  it('G-9: refuses a route with no funded destination-gas plan', async () => {
    await expect(
      initiateRailTransfer(db.pool, {
        agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 84532, destChainId: 421614,
        asset: USDC, amountWei: '1000000', destGasPlan: { destChainId: 421614, fundedWei: '0', source: 'prefunded' },
      }),
    ).rejects.toBeInstanceOf(UnfundedRouteError);

    await expect(
      initiateRailTransfer(db.pool, {
        agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 84532, destChainId: 421614,
        asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(999 /* wrong chain */),
      }),
    ).rejects.toBeInstanceOf(UnfundedRouteError);
  });

  it('CCTP happy path: initiated → source_confirmed → attested → filling → filled', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 84532, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614),
    });
    expect(t.status).toBe('initiated');
    expect(t.recoveryMode).toBe('forward_mint');
    await recordSourceSubmitted(db.pool, t.railId, '0xburn');

    const d = new FakeDriver();
    d.receipts['0xburn'] = 'success';
    await sweepRailRecovery({ pool: db.pool, driver: d });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('source_confirmed');

    d.proofs[t.railId] = { kind: 'ready', attestation: '0xattest', messageBytes: '0xmsg' };
    await sweepRailRecovery({ pool: db.pool, driver: d });
    const attested = (await getRailTransfer(db.pool, t.railId))!;
    expect(attested.status).toBe('attested');
    expect(attested.attestation).toBe('0xattest');
    expect(attested.messageBytes).toBe('0xmsg');

    await sweepRailRecovery({ pool: db.pool, driver: d }); // attested → filling (submitFill)
    const filling = (await getRailTransfer(db.pool, t.railId))!;
    expect(filling.status).toBe('filling');
    expect(filling.destTx).toBe(`0xdest-${t.railId}`);

    d.receipts[`0xdest-${t.railId}`] = 'success';
    const r = await sweepRailRecovery({ pool: db.pool, driver: d });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('filled');
    expect(r.filled).toBe(1);
  });

  it('an initiated row that never recorded a source tx is failed loudly after the window (it must not block the agent forever)', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 421614, destChainId: 84532, asset: USDC, amountWei: '5', destGasPlan: gasPlan(84532),
    });
    const d = new FakeDriver();
    // inside the window: left alone (the originator may still be about to write-ahead the hash)
    await sweepRailRecovery({ pool: db.pool, driver: d });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('initiated');
    // past the window: failed, with a message that tells a human to check the chain
    const r = await sweepRailRecovery({ pool: db.pool, driver: d, fillTimeoutMs: -60_000 });
    expect(r.failed).toBe(1);
    const row = (await getRailTransfer(db.pool, t.railId))!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/verify on-chain/);
  });

  it('source leg reverts → failed (TERMINAL)', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'ccip', srcChainId: 16602, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614),
    });
    await recordSourceSubmitted(db.pool, t.railId, '0xsend');
    const d = new FakeDriver();
    d.receipts['0xsend'] = 'reverted';
    const r = await sweepRailRecovery({ pool: db.pool, driver: d });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('failed');
    expect(r.failed).toBe(1);
  });

  it('CCTP no-fill → forward-mint recovery re-mints (never refunds backward)', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 84532, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614),
    });
    await recordSourceSubmitted(db.pool, t.railId, '0xburn');
    const d = new FakeDriver();
    d.receipts['0xburn'] = 'success';
    d.proofs[t.railId] = { kind: 'ready', messageBytes: '0xmsg' };
    // drive to filling
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → source_confirmed
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → attested
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → filling (dest tx submitted)
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('filling');

    // the fill never confirms within the window → no_fill, then claim+recover (forward mint)
    d.receipts[`0xdest-${t.railId}`] = 'reverted';
    await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // filling → no_fill
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('no_fill');

    d.fillHashes[t.railId] = '0xremint';
    await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // no_fill → recovering → filling (re-mint)
    const afterRecover = (await getRailTransfer(db.pool, t.railId))!;
    expect(afterRecover.status).toBe('filling');
    expect(afterRecover.attemptCount).toBe(1);
    expect(afterRecover.destTx).toBe('0xremint');
    expect(d.submittedRefunds).toHaveLength(0); // forward-only: never refunds a burned CCTP leg

    d.receipts['0xremint'] = 'success';
    await sweepRailRecovery({ pool: db.pool, driver: d });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('filled');
  });

  it('CCIP no-fill → refund-on-expiry (TERMINAL refunded)', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'ccip', srcChainId: 16602, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614),
    });
    expect(t.recoveryMode).toBe('refund_expiry');
    await recordSourceSubmitted(db.pool, t.railId, '0xsend');
    const d = new FakeDriver();
    d.receipts['0xsend'] = 'success';
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → source_confirmed
    // proof never comes; window elapses → no_fill (use a 0 timeout to force it, no backoff)
    await sweepRailRecovery({ pool: db.pool, driver: d, fillTimeoutMs: -60_000, retryBackoffMs: -60_000 });
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('no_fill');

    const r = await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 });
    const refunded = (await getRailTransfer(db.pool, t.railId))!;
    expect(refunded.status).toBe('refunded');
    expect(refunded.refundTx).toBe(`0xrefund-${t.railId}`);
    expect(r.refunded).toBe(1);
  });

  it('recovery exhaustion → failed, logged (never silently dropped)', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'cctp', srcChainId: 84532, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614), maxAttempts: 2,
    });
    await recordSourceSubmitted(db.pool, t.railId, '0xburn');
    const d = new FakeDriver();
    d.receipts['0xburn'] = 'success';
    d.proofs[t.railId] = { kind: 'ready', messageBytes: '0xmsg' };
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → source_confirmed
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → attested
    await sweepRailRecovery({ pool: db.pool, driver: d }); // → filling (first mint)
    // the mint reverts → no_fill, and from here every forward re-mint attempt throws
    d.receipts[`0xdest-${t.railId}`] = 'reverted';
    await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // filling → no_fill (attempt 0)
    d.fillShouldThrow.add(t.railId);
    await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // attempt 1: throws → requeue no_fill
    expect((await getRailTransfer(db.pool, t.railId))!.attemptCount).toBe(1);
    await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // attempt 2 (=max): throws → requeue
    expect((await getRailTransfer(db.pool, t.railId))!.attemptCount).toBe(2);
    const r = await sweepRailRecovery({ pool: db.pool, driver: d, retryBackoffMs: -60_000 }); // exhausted → failed
    expect((await getRailTransfer(db.pool, t.railId))!.status).toBe('failed');
    expect(r.failed).toBe(1);
  });

  it('an overridable recovery mode lets CCIP recover forward (retry-exec) when the lane supports it', async () => {
    const t = await initiateRailTransfer(db.pool, {
      agentId: AGENT, accountAddr: ACCOUNT, rail: 'ccip', srcChainId: 16602, destChainId: 421614,
      asset: USDC, amountWei: '1000000', destGasPlan: gasPlan(421614), recoveryMode: 'forward_mint',
    });
    expect(t.recoveryMode).toBe('forward_mint');
  });
});
