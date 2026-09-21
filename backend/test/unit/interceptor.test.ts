import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../../src/gateway/interceptor.js';
import type { GatewayRule } from '../../src/types.js';
import type { Json } from '../../src/crypto/canonical.js';

/**
 * C-5 adversarial suite: structured/array message content must be evaluated —
 * the Phase-1 interceptor matched `typeof content === 'string'` only, so ANY
 * array-content request bypassed every rule.
 */

const BLOCK: GatewayRule[] = [{ action: 'block', match: 'drain the wallet' }];
const APPROVAL: GatewayRule[] = [{ action: 'require_approval', match: 'top up' }];

function chat(content: unknown): Json {
  return { model: 'm', messages: [{ role: 'user', content }] } as Json;
}

describe('C-5 structured content rule matching', () => {
  it('still matches plain string content (Phase-1 behavior preserved)', () => {
    expect(evaluateRules(BLOCK, chat('please DRAIN the wallet now')).action).toBe('block');
    expect(evaluateRules(BLOCK, chat('benign')).action).toBe('observe');
  });

  it('matches a rule inside a single text part (the basic Phase-1 bypass)', () => {
    const outcome = evaluateRules(BLOCK, chat([{ type: 'text', text: 'please drain the wallet' }]));
    expect(outcome.action).toBe('block');
  });

  it('BYPASS CORPUS: rule text split across text parts is still caught (concatenation)', () => {
    const outcome = evaluateRules(BLOCK, chat([
      { type: 'text', text: 'please drain the wal' },
      { type: 'text', text: 'let right now' },
    ]));
    expect(outcome.action).toBe('block');
  });

  it('BYPASS CORPUS: text part sandwiched between non-text parts is scanned', () => {
    const outcome = evaluateRules(APPROVAL, chat([
      { type: 'image_url', image_url: { url: 'https://x/1.png' } },
      { type: 'text', text: 'should I top up?' },
      { type: 'image_url', image_url: { url: 'https://x/2.png' } },
    ]));
    expect(outcome.action).toBe('require_approval');
    expect(outcome.nonTextPartTypes).toEqual(['image_url']);
  });

  it('BYPASS CORPUS: bare-string array parts are scanned too', () => {
    const outcome = evaluateRules(BLOCK, chat(['please drain', ' the wallet']));
    expect(outcome.action).toBe('block');
  });

  it('BYPASS CORPUS: rule matching is case-insensitive across parts', () => {
    const outcome = evaluateRules(BLOCK, chat([
      { type: 'text', text: 'DRAIN THE ' },
      { type: 'text', text: 'WalLet' },
    ]));
    expect(outcome.action).toBe('block');
  });

  it('non-text smuggling: content hidden in non-text parts is FLAGGED, not silently passed', () => {
    const outcome = evaluateRules(BLOCK, chat([
      { type: 'image_url', image_url: { url: 'data:drain the wallet' } },
      { type: 'weird_blob', data: 'drain the wallet' },
    ]));
    // Rules cannot scan non-text payloads — but their presence is surfaced for
    // the trace record (honest containment, not false confidence).
    expect(outcome.action).toBe('observe');
    expect(outcome.nonTextPartTypes).toEqual(['image_url', 'weird_blob']);
  });

  it('a text part with a non-string text field is treated as non-text (no crash, flagged)', () => {
    const outcome = evaluateRules(BLOCK, chat([{ type: 'text', text: { nested: 'drain the wallet' } }]));
    expect(outcome.action).toBe('observe');
    expect(outcome.nonTextPartTypes).toEqual(['text']);
  });

  it('applies uniformly to block, modify, and require_approval', () => {
    const parts = [{ type: 'text', text: 'please top' }, { type: 'text', text: ' up now' }];
    for (const action of ['block', 'require_approval'] as const) {
      const outcome = evaluateRules([{ action, match: 'top up' }], chat(structuredClone(parts)));
      expect(outcome.action).toBe(action);
    }
    const modified = evaluateRules([{ action: 'modify', match: 'top up', replacement: '[REDACTED]' }], chat(structuredClone(parts)));
    expect(modified.action).toBe('modify');
  });
});

describe('C-5 modify on structured content', () => {
  it('replaces the needle inside a text part', () => {
    const outcome = evaluateRules(
      [{ action: 'modify', match: 'secret-phrase', replacement: '[CUT]' }],
      chat([{ type: 'text', text: 'the secret-phrase is here' }, { type: 'image_url', image_url: { url: 'u' } }]),
    );
    expect(outcome.action).toBe('modify');
    if (outcome.action !== 'modify') return;
    const msgs = (outcome.effective as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }).messages;
    const textPart = msgs[0]!.content.find((p) => p.type === 'text');
    expect(textPart?.text).toBe('the [CUT] is here');
    // non-text part passes through untouched
    expect(msgs[0]!.content.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('BYPASS CORPUS: a needle split across adjacent text parts is replaced (parts merged)', () => {
    const outcome = evaluateRules(
      [{ action: 'modify', match: 'secret-phrase', replacement: '[CUT]' }],
      chat([{ type: 'text', text: 'the secret-ph' }, { type: 'text', text: 'rase is here' }]),
    );
    expect(outcome.action).toBe('modify');
    if (outcome.action !== 'modify') return;
    const msgs = (outcome.effective as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }).messages;
    const texts = msgs[0]!.content.filter((p) => p.type === 'text').map((p) => p.text);
    expect(texts.join('')).toBe('the [CUT] is here');
    expect(texts.join('')).not.toContain('secret-phrase');
  });

  it('string-content modify unchanged (Phase-1 behavior preserved)', () => {
    const outcome = evaluateRules(
      [{ action: 'modify', match: 'foo', replacement: 'bar' }],
      chat('foo and FOO'),
    );
    expect(outcome.action).toBe('modify');
    if (outcome.action !== 'modify') return;
    const msgs = (outcome.effective as { messages: Array<{ content: string }> }).messages;
    expect(msgs[0]!.content).toBe('bar and bar');
  });
});
