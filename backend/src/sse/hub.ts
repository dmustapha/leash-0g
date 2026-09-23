import type { Response } from 'express';

/**
 * Per-agent SSE fan-out: reasoning tokens, trace events, approval requests,
 * status changes. Owner clients attach via GET /api/agents/:id/stream.
 *
 * Phase 3 (S8): an OWNER-level aggregate channel multiplexes every agent's
 * events tagged `agentId` — plus owner-only `alert`/`digest_ready` frames.
 * `reasoning` token streams are deliberately NOT fanned out owner-level
 * (per-cycle token volume × N agents would drown the aggregate; reasoning is
 * watched on the per-agent cockpit stream). The agent→owner mapping is
 * resolved lazily via the injected lookup and cached (immutable mapping).
 *
 * Phase 4 (P4C-1): connections are bounded. A single Render instance's FDs/
 * heap are finite, so one authed owner must not be able to open unbounded
 * streams. `register` enforces a GLOBAL cap and a PER-OWNER cap (rejecting
 * with 429 before writing the SSE head), and every connection carries a
 * heartbeat that reaps idle/zombie sockets (a dead peer fails the write, so we
 * close it and free the FD instead of leaking it). Defaults are config-driven
 * (07 revisit trigger = first external users / mainnet).
 */

export interface SseLimits {
  /** Max concurrent connections across ALL owners/agents on this instance. */
  maxGlobal: number;
  /** Max concurrent connections attributable to a single owner. */
  maxPerOwner: number;
  /** Heartbeat interval; a failed heartbeat write closes the connection. */
  idleTimeoutMs: number;
}

const DEFAULT_LIMITS: SseLimits = {
  maxGlobal: Number.MAX_SAFE_INTEGER,
  maxPerOwner: Number.MAX_SAFE_INTEGER,
  idleTimeoutMs: 300_000,
};

interface Conn {
  res: Response;
  ownerAddr: string | null;
  heartbeat: ReturnType<typeof setInterval>;
}

export class SseHub {
  private readonly clients = new Map<string, Set<Response>>();
  private ownerLookup: ((agentId: string) => Promise<string | null>) | null = null;
  private readonly ownerCache = new Map<string, string>();

  // P4C-1 bookkeeping: one Conn per live Response; per-owner tallies drive the
  // cap and are decremented on close. `totalCount` is the global tally.
  private readonly conns = new Map<Response, Conn>();
  private readonly perOwnerCount = new Map<string, number>();
  private totalCount = 0;
  private readonly limits: SseLimits;

  constructor(limits?: Partial<SseLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Wire the agent→owner resolver (index.ts / test helper). Unset ⇒ no owner fan-out. */
  setOwnerLookup(fn: (agentId: string) => Promise<string | null>): void {
    this.ownerLookup = fn;
  }

  /**
   * Attach a per-agent cockpit stream. `ownerAddr` (when known at the route)
   * is used ONLY for the per-owner connection cap — it never changes the
   * frame routing (agent streams stay keyed by agentId). Returns false if a
   * cap rejected the connection (the caller has already been sent a 429).
   */
  attach(agentId: string, res: Response, ownerAddr?: string): boolean {
    return this.register(agentId, res, ownerAddr ?? null);
  }

  /** Owner aggregate stream (spec §4 GET /api/owner/stream). */
  attachOwner(ownerAddr: string, res: Response): boolean {
    return this.register(`owner:${ownerAddr.toLowerCase()}`, res, ownerAddr.toLowerCase());
  }

  private register(key: string, res: Response, ownerAddr: string | null): boolean {
    const owner = ownerAddr ? ownerAddr.toLowerCase() : null;
    // Caps enforced BEFORE the SSE head so we can still send a real 429.
    if (this.totalCount >= this.limits.maxGlobal) {
      res.status(429).json({ error: 'sse_capacity', scope: 'global' });
      return false;
    }
    if (owner !== null && (this.perOwnerCount.get(owner) ?? 0) >= this.limits.maxPerOwner) {
      res.status(429).json({ error: 'sse_capacity', scope: 'owner' });
      return false;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: connected\ndata: {}\n\n`);

    let set = this.clients.get(key);
    if (!set) {
      set = new Set();
      this.clients.set(key, set);
    }
    set.add(res);

    this.totalCount += 1;
    if (owner !== null) this.perOwnerCount.set(owner, (this.perOwnerCount.get(owner) ?? 0) + 1);

    // Heartbeat reaper: a dead/zombie peer fails this write (throw or a later
    // socket error), so we close it and free the FD rather than leaking it.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: hb\n\n`);
      } catch {
        this.closeConn(key, res);
      }
    }, this.limits.idleTimeoutMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    this.conns.set(res, { res, ownerAddr: owner, heartbeat });

    const onClose = (): void => this.closeConn(key, res);
    res.on('close', onClose);
    res.on('error', onClose);
    return true;
  }

  private closeConn(key: string, res: Response): void {
    const conn = this.conns.get(res);
    if (!conn) return; // idempotent — close + error can both fire
    this.conns.delete(res);
    clearInterval(conn.heartbeat);

    const set = this.clients.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) this.clients.delete(key);
    }
    this.totalCount = Math.max(0, this.totalCount - 1);
    if (conn.ownerAddr !== null) {
      const next = (this.perOwnerCount.get(conn.ownerAddr) ?? 1) - 1;
      if (next <= 0) this.perOwnerCount.delete(conn.ownerAddr);
      else this.perOwnerCount.set(conn.ownerAddr, next);
    }
    try {
      res.end();
    } catch {
      /* already ended */
    }
  }

  emit(agentId: string, event: string, data: unknown): void {
    this.writeFrame(agentId, event, data);
    // Owner-level fan-out at THE emit chokepoint (spec §3b) — every per-agent
    // event re-emits tagged, except reasoning tokens (volume, see header).
    if (event === 'reasoning') return;
    void this.fanOutOwner(agentId, event, data);
  }

  /** Owner-only frames (alert, digest_ready). */
  emitOwner(ownerAddr: string, event: string, data: unknown): void {
    this.writeFrame(`owner:${ownerAddr.toLowerCase()}`, event, data);
  }

  private async fanOutOwner(agentId: string, event: string, data: unknown): Promise<void> {
    try {
      const owner = await this.resolveOwner(agentId);
      if (!owner) return;
      this.emitOwner(owner, event, { type: 'agent_event', agentId, event: data });
    } catch (err) {
      console.error(`owner fan-out failed for agent ${agentId}`, err);
    }
  }

  private async resolveOwner(agentId: string): Promise<string | null> {
    const cached = this.ownerCache.get(agentId);
    if (cached !== undefined) return cached;
    if (!this.ownerLookup) return null;
    const owner = await this.ownerLookup(agentId);
    if (owner) this.ownerCache.set(agentId, owner.toLowerCase());
    return owner ? owner.toLowerCase() : null;
  }

  private writeFrame(key: string, event: string, data: unknown): void {
    const set = this.clients.get(key);
    if (!set) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      res.write(frame);
    }
  }

  clientCount(agentId: string): number {
    return this.clients.get(agentId)?.size ?? 0;
  }

  /** P4C-1 introspection (tests / ops): live global + per-owner tallies. */
  totalConnections(): number {
    return this.totalCount;
  }

  ownerConnections(ownerAddr: string): number {
    return this.perOwnerCount.get(ownerAddr.toLowerCase()) ?? 0;
  }
}
