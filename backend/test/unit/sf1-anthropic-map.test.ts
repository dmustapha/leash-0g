/* eslint-disable @typescript-eslint/no-explicit-any -- tests introspect dynamic adapter JSON */
import { describe, it, expect } from 'vitest';
import { anthropicToOpenAI, openAIToAnthropic, anthropicError } from '../../src/gateway/protocols/anthropic.js';
import type { Json } from '../../src/crypto/canonical.js';

function openaiOf(body: Record<string, Json>) {
  const r = anthropicToOpenAI(body);
  if (!r.ok) throw new Error(`adapt failed: ${r.reason}`);
  return r.openai as Record<string, any>;
}

describe('SF-1 BR-F1 — Anthropic request → OpenAI body', () => {
  it('hoists `system` to a leading system message', () => {
    const o = openaiOf({ model: 'c', max_tokens: 50, system: 'be terse', messages: [{ role: 'user', content: 'hi' }] });
    expect(o.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(o.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(o.max_tokens).toBe(50);
  });

  it('concatenates a structured system array into one system message', () => {
    const o = openaiOf({
      model: 'c',
      max_tokens: 50,
      system: [{ type: 'text', text: 'a ' }, { type: 'text', text: 'b' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(o.messages[0]).toEqual({ role: 'system', content: 'a b' });
  });

  it('maps tool_use blocks → assistant tool_calls (arguments JSON-stringified)', () => {
    const o = openaiOf({
      model: 'c',
      max_tokens: 50,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'get_price', input: { sym: 'ETH' } }] },
      ],
    });
    const asst = o.messages[0];
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe('calling');
    expect(asst.tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'get_price', arguments: JSON.stringify({ sym: 'ETH' }) } },
    ]);
  });

  it('maps tool_result blocks → role:tool messages that PRECEDE residual user text', () => {
    const o = openaiOf({
      model: 'c',
      max_tokens: 50,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'price=3000' }, { type: 'text', text: 'thanks' }] },
      ],
    });
    expect(o.messages[0]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'price=3000' });
    expect(o.messages[1]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('maps tools[] and tool_choice', () => {
    const o = openaiOf({
      model: 'c',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'does f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    });
    expect(o.tools).toEqual([{ type: 'function', function: { name: 'f', description: 'does f', parameters: { type: 'object' } } }]);
    expect(o.tool_choice).toBe('required');
  });

  it('maps a base64 image block → an image_url data URL', () => {
    const o = openaiOf({
      model: 'c',
      max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    });
    expect(o.messages[0].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  });

  it('fails CLOSED on an unsupported image source', () => {
    const r = anthropicToOpenAI({ model: 'c', max_tokens: 50, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file' } }] }] });
    expect(r.ok).toBe(false);
  });

  it('maps stop_sequences → stop and copies sampling params', () => {
    const o = openaiOf({ model: 'c', max_tokens: 50, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'], messages: [{ role: 'user', content: 'hi' }] });
    expect(o.stop).toEqual(['END']);
    expect(o.temperature).toBe(0.2);
    expect(o.top_p).toBe(0.9);
  });
});

describe('SF-1 BR-F1 — OpenAI response → Anthropic response', () => {
  it('maps text content + finish_reason + usage', () => {
    const a = openAIToAnthropic(
      { id: 'cmpl-1', model: 'srv', choices: [{ message: { role: 'assistant', content: 'the answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      'claude',
    );
    expect(a.id).toBe('cmpl-1');
    expect(a.type).toBe('message');
    expect(a.role).toBe('assistant');
    expect(a.content).toEqual([{ type: 'text', text: 'the answer' }]);
    expect(a.stop_reason).toBe('end_turn');
    expect(a.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('maps tool_calls → tool_use (input JSON-parsed) and finish tool_calls → tool_use', () => {
    const a = openAIToAnthropic(
      { id: 'x', choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }] },
      'claude',
    );
    expect(a.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }]);
    expect(a.stop_reason).toBe('tool_use');
  });

  it('maps length → max_tokens and echoes reqModel when backend omits model', () => {
    const a = openAIToAnthropic({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'claude-req');
    expect(a.stop_reason).toBe('max_tokens');
    expect(a.model).toBe('claude-req');
  });

  it('fails safe to empty input on unparseable tool arguments', () => {
    const a = openAIToAnthropic({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'f', arguments: 'not json' } }] }, finish_reason: 'tool_calls' }] }, 'c');
    expect((a.content as any)[0].input).toEqual({});
  });
});

describe('SF-1 — Anthropic error envelope', () => {
  it('maps HTTP status → Anthropic error type', () => {
    expect(anthropicError(400, 'bad').error).toMatchObject({ type: 'invalid_request_error', message: 'bad' });
    expect(anthropicError(401, 'x').error).toMatchObject({ type: 'authentication_error' });
    expect(anthropicError(403, 'x').error).toMatchObject({ type: 'permission_error' });
    expect(anthropicError(502, 'x').error).toMatchObject({ type: 'api_error' });
    expect(anthropicError(400, 'x').type).toBe('error');
  });
});
