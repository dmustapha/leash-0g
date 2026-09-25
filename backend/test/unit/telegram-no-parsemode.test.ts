import { describe, it, expect } from 'vitest';
import { FetchTelegramApi } from '../../src/telegram/api.js';

// P5C-3 (I-01): the quarantine invariant on the Telegram surface — outbound
// messages carry UNTRUSTED, agent-authored text (deliverable summaries, agent
// intent). Telegram must send them as PLAIN TEXT: setting parse_mode
// (HTML/MarkdownV2) would turn stray markup in that untrusted text into an
// injection/formatting surface. This test fails if any outbound call ever
// serializes a `parse_mode` field.

function captureFetch(bodies: string[]): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(init.body);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('Telegram never sets parse_mode (I-01)', () => {
  it('sendMessage body has no parse_mode', async () => {
    const bodies: string[] = [];
    const api = new FetchTelegramApi({ botToken: 'x', fetchFn: captureFetch(bodies) });
    await api.sendMessage({ chat_id: '1', text: 'untrusted *_`<b> text' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/parse_mode/);
    expect(JSON.parse(bodies[0] as string)).not.toHaveProperty('parse_mode');
  });

  it('editMessageText body has no parse_mode', async () => {
    const bodies: string[] = [];
    const api = new FetchTelegramApi({ botToken: 'x', fetchFn: captureFetch(bodies) });
    await api.editMessageText({ chat_id: '1', message_id: 2, text: 'edited <untrusted>' });
    expect(bodies[0]).not.toMatch(/parse_mode/);
  });
});
