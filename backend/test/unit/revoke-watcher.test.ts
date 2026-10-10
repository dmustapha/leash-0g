import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RevokeWatcher } from '../../src/chain/revoke-watcher.js';

// DM-9: isolate the watcher's cursor/reorg/span logic from the DB + fan-out.
// vi.hoisted so the mock factories can reference these without the hoisting trap.
const { listActiveAgents, applyRevokeFanout } = vi.hoisted(() => ({
  listActiveAgents: vi.fn(),
  applyRevokeFanout: vi.fn(),
}));
vi.mock('../../src/store/agents.js', () => ({ listActiveAgents }));
vi.mock('../../src/agents/revoke-fanout.js', () => ({ applyRevokeFanout }));

type Deps = ConstructorParameters<typeof RevokeWatcher>[0];

const CHAIN = 16600;

function addr(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

/** In-memory cursor store that records every load/save. */
function fakeCursor(initial: bigint | null) {
  const store = new Map<number, bigint>();
  if (initial !== null) store.set(CHAIN, initial);
  const saves: bigint[] = [];
  return {
    saves,
    store,
    load: vi.fn(async (chainId: number) => store.get(chainId) ?? null),
    save: vi.fn(async (chainId: number, b: bigint) => {
      store.set(chainId, b);
      saves.push(b);
    }),
  };
}

/** Source whose head is controllable; records every getRevokedAccounts window. */
function fakeSource(revokedAccounts: string[] = []) {
  let head = 0n;
  const windows: Array<{ from: bigint; to: bigint }> = [];
  return {
    windows,
    setHead: (h: bigint) => {
      head = h;
    },
    getBlockNumber: vi.fn(async () => head),
    getRevokedAccounts: vi.fn(async (from: bigint, to: bigint) => {
      windows.push({ from, to });
      return revokedAccounts;
    }),
  };
}

function makeWatcher(
  cursor: ReturnType<typeof fakeCursor>,
  source: ReturnType<typeof fakeSource>,
  opts: { reorgDepth?: bigint; maxBlockSpan?: bigint } = {},
) {
  const deps = {
    pool: {} as never,
    hub: {} as never,
    runtime: {} as never,
    coordinator: {} as never,
    alerts: undefined,
    source,
    cursor,
    chainId: CHAIN,
  } as unknown as Deps;
  return new RevokeWatcher(deps, 5_000, opts.reorgDepth ?? 12n, opts.maxBlockSpan ?? 2_000n);
}

beforeEach(() => {
  listActiveAgents.mockReset();
  applyRevokeFanout.mockReset();
  listActiveAgents.mockResolvedValue([{ id: 'a1', accountAddr: addr(1) }]);
});

describe('RevokeWatcher cursor durability + reorg (DM-9)', () => {
  it('first-ever boot (no persisted cursor) seeds to head and scans nothing', async () => {
    const cursor = fakeCursor(null);
    const source = fakeSource();
    source.setHead(100n);
    await makeWatcher(cursor, source).tick();

    expect(cursor.load).toHaveBeenCalledWith(CHAIN);
    expect(cursor.saves).toEqual([100n]); // seeded
    expect(source.getRevokedAccounts).not.toHaveBeenCalled(); // no history to replay
  });

  it('resumes from the persisted cursor (rewound by reorgDepth), NOT from head', async () => {
    const cursor = fakeCursor(50n); // we were at 50 before the restart
    const source = fakeSource();
    source.setHead(60n);
    await makeWatcher(cursor, source, { reorgDepth: 12n }).tick();

    // scans (50-12, 60] = (38, 60] — the blocks emitted while down are NOT skipped
    expect(source.windows).toEqual([{ from: 38n, to: 60n }]);
    expect(cursor.saves).toEqual([60n]);
  });

  it('rewinds and reprocesses on a reorg (head moves backwards below the cursor)', async () => {
    const cursor = fakeCursor(60n);
    const source = fakeSource();
    const w = makeWatcher(cursor, source, { reorgDepth: 0n }); // isolate reorg math
    source.setHead(60n);
    await w.tick(); // resume: lastBlock=60, head=60 -> no new blocks, no scan
    expect(source.getRevokedAccounts).not.toHaveBeenCalled();

    source.setHead(55n); // REORG: head went backwards
    await w.tick();
    // rewound to head-reorgDepth = 55, then head(55) <= lastBlock(55) -> still no scan;
    // advance head past it to prove the rewound window is actually re-scanned.
    source.setHead(58n);
    await w.tick();
    expect(source.windows.at(-1)).toEqual({ from: 55n, to: 58n });
  });

  it('bounds each tick to maxBlockSpan and catches up over subsequent ticks', async () => {
    const cursor = fakeCursor(100n);
    const source = fakeSource();
    const w = makeWatcher(cursor, source, { reorgDepth: 0n, maxBlockSpan: 10n });
    source.setHead(1000n); // 900 blocks behind

    await w.tick();
    expect(source.windows.at(-1)).toEqual({ from: 100n, to: 110n }); // bounded to +10
    expect(cursor.saves.at(-1)).toBe(110n);

    await w.tick();
    expect(source.windows.at(-1)).toEqual({ from: 110n, to: 120n }); // next window
    expect(cursor.saves.at(-1)).toBe(120n);
  });

  it('fans out revoke for an account seen in the window and advances the cursor', async () => {
    const cursor = fakeCursor(50n);
    const source = fakeSource([addr(1)]); // the active agent was revoked
    source.setHead(60n);
    await makeWatcher(cursor, source, { reorgDepth: 0n }).tick();

    expect(applyRevokeFanout).toHaveBeenCalledTimes(1);
    expect(applyRevokeFanout).toHaveBeenCalledWith(expect.anything(), 'a1', 'onchain-event');
    expect(cursor.saves).toEqual([60n]); // cursor persisted only after fan-out
  });

  it('advances + persists the cursor even with zero active agents (no watched accounts)', async () => {
    // Locks the invariant that persist lives OUTSIDE the agents.length>0 guard —
    // a refactor moving it inside would silently re-introduce the skip bug.
    listActiveAgents.mockResolvedValue([]);
    const cursor = fakeCursor(50n);
    const source = fakeSource();
    source.setHead(60n);
    await makeWatcher(cursor, source, { reorgDepth: 0n }).tick();

    expect(source.getRevokedAccounts).not.toHaveBeenCalled(); // nothing to scan
    expect(cursor.saves).toEqual([60n]); // but the cursor still advances (no re-scan stall)
  });

  it('does not advance the durable cursor if the scan throws (fail-safe re-scan next boot)', async () => {
    const cursor = fakeCursor(50n);
    const source = fakeSource();
    source.setHead(60n);
    source.getRevokedAccounts.mockRejectedValueOnce(new Error('rpc down'));
    const w = makeWatcher(cursor, source, { reorgDepth: 0n });

    await expect(w.tick()).rejects.toThrow('rpc down');
    expect(cursor.saves).toEqual([]); // cursor NOT moved — next tick re-scans
  });
});
