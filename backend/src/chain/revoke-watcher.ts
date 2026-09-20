import type { Pool } from 'pg';
import { applyRevokeFanout, type RevokeFanoutDeps } from '../agents/revoke-fanout.js';
import { listActiveAgents } from '../store/agents.js';

/** Minimal chain-log surface so tests can inject a fake client. */
export interface RevokedLogSource {
  getBlockNumber(): Promise<bigint>;
  /** Return the addresses (lowercase) that emitted Revoked in (fromBlock, toBlock]. */
  getRevokedAccounts(fromBlock: bigint, toBlock: bigint, accounts: string[]): Promise<string[]>;
}

export interface RevokeWatcherDeps extends RevokeFanoutDeps {
  pool: Pool;
  source: RevokedLogSource;
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
      if (this.lastBlock === null) {
        this.lastBlock = head;
        return;
      }
      if (head <= this.lastBlock) return;
      const agents = await listActiveAgents(this.deps.pool);
      if (agents.length > 0) {
        const byAccount = new Map(agents.map((a) => [a.accountAddr.toLowerCase(), a]));
        const revoked = await this.deps.source.getRevokedAccounts(
          this.lastBlock,
          head,
          [...byAccount.keys()],
        );
        for (const account of revoked) {
          const agent = byAccount.get(account.toLowerCase());
          if (agent) await applyRevokeFanout(this.deps, agent.id, 'onchain-event');
        }
      }
      this.lastBlock = head;
    } finally {
      this.ticking = false;
    }
  }
}
