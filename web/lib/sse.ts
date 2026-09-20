// File: web/lib/sse.ts
// Fetch-based SSE client with Bearer auth (native EventSource cannot send headers) and
// auto-reconnect with capped exponential backoff.

export type SseHandle = { close: () => void };

export type SseOptions = {
  url: string;
  getToken: () => Promise<string | null>;
  onEvent: (data: unknown) => void;
  onStatusChange?: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  /** base backoff ms (doubles per attempt, capped at 15s) */
  baseDelayMs?: number;
};

export function connectSse(opts: SseOptions): SseHandle {
  let closed = false;
  let attempt = 0;
  let abort: AbortController | null = null;

  const notify = (s: 'connecting' | 'open' | 'reconnecting' | 'closed') =>
    opts.onStatusChange?.(s);

  async function run(): Promise<void> {
    while (!closed) {
      abort = new AbortController();
      try {
        notify(attempt === 0 ? 'connecting' : 'reconnecting');
        const token = await opts.getToken();
        const res = await fetch(opts.url, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        notify('open');
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            try {
              opts.onEvent(JSON.parse(data));
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (closed) break;
      attempt += 1;
      const delay = Math.min((opts.baseDelayMs ?? 1000) * 2 ** (attempt - 1), 15_000);
      await new Promise((r) => setTimeout(r, delay));
    }
    notify('closed');
  }

  void run();

  return {
    close: () => {
      closed = true;
      abort?.abort();
    },
  };
}
