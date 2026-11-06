import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { initiateRailTransfer, recordSourceSubmitted, getRailTransfer, type DestGasPlan } from '../../src/store/rail-transfers.js';
import { sweepRailRecovery } from '../../src/runtime/rail-recovery.js';
import { createCctpRailDriver, parseCctpBurnMessage } from '../../src/runtime/cctp-driver.js';
import { burnMessage, FakeIris, FakeCctpChains } from '../helpers/cctp-fakes.js';

/**
 * AQ-FND M-3 inc-3b S2 — the CCTP RailDriver through the REAL recovery sweep + DB. The fake
 * destination chain enforces the MessageTransmitter's refusals (bad attestation, nonce replay),
 * and the Iris fake can return several messages for one burn tx.
 */
const ACCOUNT = '0x' + 'c2'.repeat(20);
const OTHER = '0x' + 'd3'.repeat(20);
const USDC = '0x' + 'a1'.repeat(20);
const TRANSMITTER = ('0x' + 'e7'.repeat(20)) as `0x${string}`;
const SRC = 421614; // Arb Sepolia (domain 3)
const DEST = 84532; // Base Sepolia (domain 6)
const gasPlan: DestGasPlan = { destChainId: DEST, fundedWei: '1000000000000000', source: 'prefunded' };
const AMOUNT = 2_000_000n;

const good = burnMessage({ srcDomain: 3, destDomain: 6, nonce: 7, recipient: ACCOUNT, amount: AMOUNT });

describe('parseCctpBurnMessage', () => {
  it('reads dest domain, recipient and amount; rejects short or dirty-recipient messages', () => {
    expect(parseCctpBurnMessage(good)).toEqual({ destDomain: 6, mintRecipient: ACCOUNT, amount: AMOUNT });
    expect(parseCctpBurnMessage('0x1234')).toBeNull();
    const dirty = good.slice(0, 2 + 184 * 2) + 'ff' + good.slice(2 + 184 * 2 + 2);
    expect(parseCctpBurnMessage(dirty)).toBeNull();
  });
});

describe('CCTP rail driver (inc-3b S2)', () => {
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

  async function openRow(railId: string) {
    const row = await initiateRailTransfer(db.pool, {
      railId, agentId: 'agent-cctp', accountAddr: ACCOUNT, rail: 'cctp', srcChainId: SRC, destChainId: DEST,
      asset: USDC, amountWei: AMOUNT.toString(), destGasPlan: gasPlan,
    });
    await recordSourceSubmitted(db.pool, row.railId, `0xburn-${railId}`);
    return row;
  }
  const rig = (messages: Hex[], pendingPolls = 0) => {
    const chains = new FakeCctpChains();
    const iris = new FakeIris(messages, pendingPolls);
    const driver = createCctpRailDriver({ iris, chains, messageTransmitter: () => TRANSMITTER });
    return { chains, iris, driver };
  };
  type Hex = `0x${string}`;

  it('drives initiated -> filled; waits on a pending attestation; picks ITS message among several', async () => {
    const decoy = burnMessage({ srcDomain: 3, destDomain: 6, nonce: 8, recipient: OTHER, amount: AMOUNT });
    const { chains, iris, driver } = rig([decoy, good], 1);
    const row = await openRow('00000000-0000-4000-8000-000000000001');
    chains.receipts.set('0xburn-00000000-0000-4000-8000-000000000001', 'success');
    const tick = () => sweepRailRecovery({ pool: db.pool, driver });
    await tick(); // initiated -> source_confirmed
    expect((await getRailTransfer(db.pool, row.railId))!.status).toBe('source_confirmed');
    await tick(); // iris still pending
    expect((await getRailTransfer(db.pool, row.railId))!.status).toBe('source_confirmed');
    await tick(); // attested
    expect((await getRailTransfer(db.pool, row.railId))!.status).toBe('attested');
    await tick(); // fill broadcast
    await tick(); // fill confirmed
    const done = await getRailTransfer(db.pool, row.railId);
    expect(done!.status).toBe('filled');
    expect(iris.polls).toBeGreaterThanOrEqual(2);
    expect(chains.minted).toEqual([{ recipient: ACCOUNT, amount: AMOUNT }]);
  });

  it('never attests when Iris offers only other recipients or amounts (stays pending)', async () => {
    const wrongAmt = burnMessage({ srcDomain: 3, destDomain: 6, nonce: 9, recipient: ACCOUNT, amount: AMOUNT + 1n });
    const wrongDom = burnMessage({ srcDomain: 3, destDomain: 0, nonce: 10, recipient: ACCOUNT, amount: AMOUNT });
    const { chains, driver } = rig([wrongAmt, wrongDom]);
    const row = await openRow('00000000-0000-4000-8000-000000000002');
    chains.receipts.set('0xburn-00000000-0000-4000-8000-000000000002', 'success');
    await sweepRailRecovery({ pool: db.pool, driver });
    await sweepRailRecovery({ pool: db.pool, driver });
    expect((await getRailTransfer(db.pool, row.railId))!.status).toBe('source_confirmed');
    expect(chains.sent).toHaveLength(0);
  });

  it('refuses to mint a tampered stored message; a replayed nonce reverts into no_fill', async () => {
    const { chains, driver } = rig([good]);
    const row = await openRow('00000000-0000-4000-8000-000000000003');
    await expect(
      driver.submitFill({ ...row, status: 'attested', messageBytes: burnMessage({ srcDomain: 3, destDomain: 6, nonce: 1, recipient: OTHER, amount: AMOUNT }), attestation: '0x01' }),
    ).rejects.toThrow(/does not match/);
    chains.usedNonces.add(`0x${good.slice(2 + 12 * 2, 2 + 44 * 2)}`); // someone already minted this nonce
    chains.receipts.set('0xburn-00000000-0000-4000-8000-000000000003', 'success');
    for (let i = 0; i < 5; i += 1) await sweepRailRecovery({ pool: db.pool, driver });
    expect((await getRailTransfer(db.pool, row.railId))!.status).toBe('no_fill');
    expect(chains.minted).toHaveLength(0);
  });

  it('is forward-only and CCTP-only', async () => {
    const { driver } = rig([good]);
    const row = await openRow('00000000-0000-4000-8000-000000000004');
    await expect(driver.submitRefund(row)).rejects.toThrow(/forward-only/);
    await expect(driver.fetchProof({ ...row, rail: 'ccip' })).rejects.toThrow(/cannot drive/);
  });
});
