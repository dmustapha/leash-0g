import type { Pool } from 'pg';
import { applyRevokeFanout, type RevokeFanoutDeps } from '../agents/revoke-fanout.js';
import { listActiveAgents } from '../store/agents.js';

/** Minimal chain-log surface so tests can inject a fake client. */
export interface RevokedLogSource {
  getBlockNumber(): Promise<bigint>;
  /** Return the addresses (lowercase) that emitted Revoked in (fromBlock, toBlock]. */
  getRevokedAccounts(fromBlock: bigint, toBlock: bigint, accounts: string[]): Promise<string[]>;
}

/** DM-9: durable cursor persistence, one row per watched chain. */
export interface RevokeCursorStore {
  /** The last fully-scanned block for this chain, or null if never seeded. */
  load(chainId: number): Promise<bigint | null>;
  /** Persist the highest fully-scanned block for this chain. */
  save(chainId: number, lastBlock: bigint): Promise<void>;
}

export interface RevokeWatcherDeps extends RevokeFanoutDeps {
  pool: Pool;
  source: RevokedLogSource;
  /** DM-9: durable cursor so a restart resumes instead of re-seeding to head. */
  cursor: RevokeCursorStore;
  /** The chain this watcher observes (cursor key). */
  chainId: number;
}

/**
 * Poll-based Revoked-event observer (~5s): the owner can revoke directly
 * on-chain with their wallet (the LEASH-independent escape hatch) — when we
 * see the event, the same fan-out applies (runtime halt, DB mark, gateway
 * 403).
 */
export class RevokeWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastBlock: bigint | null = null;
  private ticking = false;

  constructor(
    private readonly deps: RevokeWatcherDeps,
    private readonly intervalMs = 5_000,
    // DM-9: on resume, re-scan this many blocks below the durable cursor so a
    // shallow reorg that landed while down / between ticks is re-observed.
    private readonly reorgDepth = 12n,
    // DM-9: bound each tick's getLogs span so a long-downtime catch-up spreads
    // across ticks rather than one oversized range the RPC may reject.
    private readonly maxBlockSpan = 2_000n,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => console.error('revoke watcher tick failed', err));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll pass (also driven directly by tests). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const head = await this.deps.source.getBlockNumber();

      // DM-9: first tick after (re)start — resume from the DURABLE cursor, not
      // the chain head. Re-seeding to head skipped every Revoked emitted while
      // the process was down (revoked-on-chain-but-still-looping fail-open).
      if (this.lastBlock === null) {
        const persisted = await this.deps.cursor.load(this.deps.chainId);
        if (persisted === null) {
          // First-ever boot: no agents predate the watcher, so there is no
          // history to replay — seed the cursor and start observing from here.
          this.lastBlock = head;
          await this.deps.cursor.save(this.deps.chainId, head);
          return;
        }
        // Resume, rewound by reorgDepth to re-observe a reorg during downtime.
        this.lastBlock = persisted > this.reorgDepth ? persisted - this.reorgDepth : 0n;
      }

      // DM-9: reorg — the chain head moved BACKWARDS below our cursor. Rewind
      // and reprocess rather than swallowing it (fanout is idempotent).
      if (head < this.lastBlock) {
        this.lastBlock = head > this.reorgDepth ? head - this.reorgDepth : 0n;
      }
      if (head <= this.lastBlock) return; // genuinely no new blocks

      // DM-9: bound the scan window; if far behind, catch up over later ticks.
      const toBlock = head - this.lastBlock > this.maxBlockSpan ? this.lastBlock + this.maxBlockSpan : head;

      // listActiveAgents already excludes external binds (F-2b); the null-account
      // filter is the type-level echo of that invariant (a bound agent has no
      // on-chain account to watch for revokes).
      const agents = (await listActiveAgents(this.deps.pool)).filter(
        (a): a is typeof a & { accountAddr: string } => a.accountAddr !== null,
      );
      if (agents.length > 0) {
        const byAccount = new Map(agents.map((a) => [a.accountAddr.toLowerCase(), a]));
        const revoked = await this.deps.source.getRevokedAccounts(
          this.lastBlock,
          toBlock,
          [...byAccount.keys()],
        );
        for (const account of revoked) {
          const agent = byAccount.get(account.toLowerCase());
          if (agent) await applyRevokeFanout(this.deps, agent.id, 'onchain-event');
        }
      }
      // Advance + persist only AFTER a successful scan+fanout so a crash mid-tick
      // re-scans this window next boot (idempotent) rather than skipping it.
      this.lastBlock = toBlock;
      await this.deps.cursor.save(this.deps.chainId, toBlock);
    } finally {
      this.ticking = false;
    }
  }
}
