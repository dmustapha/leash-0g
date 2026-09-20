import type { Json } from '../crypto/canonical.js';
import type { X0gTrace } from '../types.js';

export interface ComputeQueueOptions {
  baseUrl: string;
  apiKey: string;
  maxConcurrent?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface ComputeResult {
  status: number;
  body: Json;
  x0gTrace?: X0gTrace;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Rate-limit-aware 0G Compute queue (Phase-0 gate): per-agent serialization,
 * global concurrency cap (router limit: 5), exponential backoff + retry on
 * 429/5xx/network errors, and x_0g_trace capture from every completion.
 */
export class ComputeQueue {
  private readonly opts: Required<Omit<ComputeQueueOptions, 'fetchFn'>>;
  private readonly fetchFn: typeof fetch;
  private readonly agentChains = new Map<string, Promise<unknown>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: ComputeQueueOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      apiKey: options.apiKey,
      maxConcurrent: options.maxConcurrent ?? 5,
      maxRetries: options.maxRetries ?? 4,
      baseDelayMs: options.baseDelayMs ?? 500,
      timeoutMs: options.timeoutMs ?? 90_000,
    };
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Enqueue a chat-completions call for one agent. */
  async enqueue(agentId: string, body: Json, path = '/chat/completions'): Promise<ComputeResult> {
    const prev = this.agentChains.get(agentId) ?? Promise.resolve();
    const task = prev.then(() => this.withSlot(() => this.callWithRetry(body, path)));
    // keep the chain alive regardless of task outcome
    this.agentChains.set(
      agentId,
      task.catch(() => undefined),
    );
    return task;
  }

  /** GET against the router (e.g. /models) with the same auth + retry. */
  async get(path: string): Promise<ComputeResult> {
    return this.withSlot(() => this.callWithRetry(null, path, 'GET'));
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    // Re-check after every wake: a newcomer can grab the freed slot before the
    // woken waiter runs, so acquiring without re-checking would overshoot the cap.
    while (this.active >= this.opts.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  private async callWithRetry(body: Json | null, path: string, method = 'POST'): Promise<ComputeResult> {
    let lastResult: ComputeResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.opts.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            ...(body !== null ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== null ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const parsed = await parseJson(res);
        lastResult = { status: res.status, body: parsed, ...extractTrace(parsed) };
        if (!RETRYABLE.has(res.status)) return lastResult;
      } catch (err) {
        lastError = err;
        lastResult = null;
      }
    }
    if (lastResult) return lastResult;
    throw lastError instanceof Error ? lastError : new Error('compute call failed');
  }
}

async function parseJson(res: Response): Promise<Json> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text };
  }
}

function extractTrace(body: Json): { x0gTrace?: X0gTrace } {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const t = (body as Record<string, unknown>)['x_0g_trace'];
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const trace = t as Record<string, unknown>;
      return {
        x0gTrace: {
          provider: typeof trace['provider'] === 'string' ? trace['provider'] : '',
          request_id: typeof trace['request_id'] === 'string' ? trace['request_id'] : '',
          billing: (trace['billing'] ?? null) as Json,
        },
      };
    }
  }
  return {};
}
