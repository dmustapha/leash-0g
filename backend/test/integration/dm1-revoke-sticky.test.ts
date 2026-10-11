import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import { insertAgent, setAgentStatus, getAgentById } from '../../src/store/agents.js';
import { applyRevokeFanout, type RevokeFanoutDeps } from '../../src/agents/revoke-fanout.js';
import type { AgentGoal } from '../../src/types.js';

// DM-1 (+ I-5 residual): revoke is TERMINAL at the data layer. setAgentStatus CAS
// (`status <> 'revoked'`) blocks resurrection AND makes the revoke fan-out run its
// side effects exactly once (no duplicate trace/alert when the guardian-API path
// races the on-chain watcher, or a reorg re-scan re-triggers).

let db: TestDb;
const OWNER = '0x' + '5e'.repeat(20);

async function makeAgent(): Promise<string> {
  return insertAgent(db.pool, {
    chainAgentId: BigInt(Math.floor(Math.random() * 1e9)),
    chainId: 16602,
    ownerAddr: OWNER,
    accountAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyAddr: '0x' + Math.floor(Math.random() * 1e9).toString(16).padStart(40, '0'),
    sessionKeyEnc: 'enc',
    auditPubkey: 'ab'.repeat(33),
    tokenId: `tok-${Math.random()}`,
    tokenHash: 'hash',
    accountVersion: 4,
    name: 'victim',
    gatewayRules: [],
    goal: { type: 'treasury', beneficiary: '0x' + 'be'.repeat(20) } as AgentGoal,
    guardianAddr: '0x' + 'ab'.repeat(20),
  });
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

describe('DM-1 setAgentStatus revoke-stickiness', () => {
  it('flips active -> revoked (returns true) then refuses revoked -> active (sticky, returns false)', async () => {
    const id = await makeAgent();
    expect(await setAgentStatus(db.pool, id, 'revoked')).toBe(true);
    expect((await getAgentById(db.pool, id))?.status).toBe('revoked');

    // Illegal resurrection blocked at the data layer.
    expect(await setAgentStatus(db.pool, id, 'active')).toBe(false);
    expect((await getAgentById(db.pool, id))?.status).toBe('revoked');

    // Re-revoke is a no-op (already terminal) — returns false.
    expect(await setAgentStatus(db.pool, id, 'revoked')).toBe(false);
  });
});

describe('I-5 revoke fan-out is exactly-once', () => {
  it('a second applyRevokeFanout for an already-revoked agent does not re-fan-out', async () => {
    const id = await makeAgent();
    let halts = 0;
    let traceEmits = 0;
    let statusEmits = 0;
    let cancels = 0;
    const deps: RevokeFanoutDeps = {
      pool: db.pool,
      hub: {
        emit: (_agentId: string, kind: string) => {
          if (kind === 'trace') traceEmits += 1;
          if (kind === 'status') statusEmits += 1;
        },
      } as unknown as RevokeFanoutDeps['hub'],
      runtime: {
        haltForRevoke: async () => {
          halts += 1;
        },
      },
      coordinator: {
        cancelForRevokedAgent: async () => {
          cancels += 1;
        },
      },
    };

    await applyRevokeFanout(deps, id, 'guardian-api');
    await applyRevokeFanout(deps, id, 'onchain-event'); // the race / reorg re-trigger

    expect((await getAgentById(db.pool, id))?.status).toBe('revoked');
    // haltForRevoke is idempotent belt-and-braces — runs each call (ahead of the gate).
    expect(halts).toBe(2);
    // The trace / status SSE / coordination fan-out run EXACTLY ONCE (the 2nd no-ops).
    expect(traceEmits).toBe(1);
    expect(statusEmits).toBe(1);
    expect(cancels).toBe(1);
  });
});
