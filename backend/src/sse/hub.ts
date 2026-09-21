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
 */
export class SseHub {
  private readonly clients = new Map<string, Set<Response>>();
  private ownerLookup: ((agentId: string) => Promise<string | null>) | null = null;
  private readonly ownerCache = new Map<string, string>();

  /** Wire the agent→owner resolver (index.ts / test helper). Unset ⇒ no owner fan-out. */
  setOwnerLookup(fn: (agentId: string) => Promise<string | null>): void {
    this.ownerLookup = fn;
  }

  attach(agentId: string, res: Response): void {
    this.attachKey(agentId, res);
  }

  /** Owner aggregate stream (spec §4 GET /api/owner/stream). */
  attachOwner(ownerAddr: string, res: Response): void {
    this.attachKey(`owner:${ownerAddr.toLowerCase()}`, res);
  }

  private attachKey(key: string, res: Response): void {
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
    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(key);
    });
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
}
