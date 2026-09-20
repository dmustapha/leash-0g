import type { Response } from 'express';

/**
 * Per-agent SSE fan-out: reasoning tokens, trace events, approval requests,
 * status changes. Owner clients attach via GET /api/agents/:id/stream.
 */
export class SseHub {
  private readonly clients = new Map<string, Set<Response>>();

  attach(agentId: string, res: Response): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: connected\ndata: {}\n\n`);
    let set = this.clients.get(agentId);
    if (!set) {
      set = new Set();
      this.clients.set(agentId, set);
    }
    set.add(res);
    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(agentId);
    });
  }

  emit(agentId: string, event: string, data: unknown): void {
    const set = this.clients.get(agentId);
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
