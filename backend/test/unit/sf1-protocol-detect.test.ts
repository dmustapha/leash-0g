import { describe, it, expect } from 'vitest';
import { detectProtocol, isAnthropicRequestShape, isJsonRpcShape } from '../../src/gateway/protocols/detect.js';

const ANTHROPIC = { model: 'claude', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
const OPENAI = { model: 'gpt', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }] };

describe('SF-1 F-1c — exact-path/exact-shape protocol detection (fail-closed)', () => {
  it('routes exact paths to their protocol when the shape matches', () => {
    expect(detectProtocol('/v1/chat/completions', OPENAI)).toBe('openai');
    expect(detectProtocol('/v1/messages', ANTHROPIC)).toBe('anthropic');
    expect(detectProtocol('/mcp', { jsonrpc: '2.0', method: 'tools/list' })).toBe('mcp');
  });

  it('REFUSES an unknown path, never guesses', () => {
    expect(detectProtocol('/v2/messages', ANTHROPIC)).toBeNull();
    expect(detectProtocol('/completions', OPENAI)).toBeNull();
  });

  it('REFUSES an OpenAI body smuggled onto /v1/messages (protocol-confusion)', () => {
    // OpenAI lacks max_tokens-required + uses a system role in messages[].
    expect(detectProtocol('/v1/messages', OPENAI)).toBeNull();
  });

  it('REFUSES a non-JSON-RPC body on /mcp', () => {
    expect(detectProtocol('/mcp', { hello: 'world' })).toBeNull();
    expect(detectProtocol('/mcp', { jsonrpc: '1.0', method: 'x' })).toBeNull();
  });
});

describe('SF-1 — isAnthropicRequestShape strictness', () => {
  it('accepts a minimal valid request', () => {
    expect(isAnthropicRequestShape(ANTHROPIC)).toBe(true);
  });

  it('requires max_tokens as a positive integer', () => {
    expect(isAnthropicRequestShape({ model: 'c', messages: [{ role: 'user', content: 'x' }] })).toBe(false);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, max_tokens: 0 })).toBe(false);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, max_tokens: 1.5 })).toBe(false);
  });

  it('rejects non-user/assistant roles (system is top-level in Anthropic)', () => {
    expect(isAnthropicRequestShape({ ...ANTHROPIC, messages: [{ role: 'system', content: 'x' }] })).toBe(false);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, messages: [{ role: 'tool', content: 'x' }] })).toBe(false);
  });

  it('rejects an unknown content block type (shape-smuggling)', () => {
    const body = { ...ANTHROPIC, messages: [{ role: 'user', content: [{ type: 'evil_exec', cmd: 'rm -rf' }] }] };
    expect(isAnthropicRequestShape(body)).toBe(false);
  });

  it('accepts known content block types', () => {
    const body = {
      ...ANTHROPIC,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    };
    expect(isAnthropicRequestShape(body)).toBe(true);
  });

  it('SEC H-01: validates tool_result nested content (string or known sub-blocks), refuses unknown nested shapes', () => {
    const ok1 = { ...ANTHROPIC, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'plain' }] }] };
    const ok2 = { ...ANTHROPIC, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x' }] }] }] };
    const bad = { ...ANTHROPIC, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'exec', cmd: 'rm' }] }] }] };
    const bad2 = { ...ANTHROPIC, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 42 }] }] };
    expect(isAnthropicRequestShape(ok1)).toBe(true);
    expect(isAnthropicRequestShape(ok2)).toBe(true);
    expect(isAnthropicRequestShape(bad)).toBe(false);
    expect(isAnthropicRequestShape(bad2)).toBe(false);
  });

  it('rejects an empty or missing messages array, and non-object bodies', () => {
    expect(isAnthropicRequestShape({ ...ANTHROPIC, messages: [] })).toBe(false);
    expect(isAnthropicRequestShape('nope')).toBe(false);
    expect(isAnthropicRequestShape(null)).toBe(false);
    expect(isAnthropicRequestShape([ANTHROPIC])).toBe(false);
  });

  it('validates an optional system field', () => {
    expect(isAnthropicRequestShape({ ...ANTHROPIC, system: 'be concise' })).toBe(true);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, system: [{ type: 'text', text: 'hi' }] })).toBe(true);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, system: [{ type: 'image' }] })).toBe(false);
    expect(isAnthropicRequestShape({ ...ANTHROPIC, system: 42 })).toBe(false);
  });
});

describe('SF-1 — isJsonRpcShape', () => {
  it('requires jsonrpc 2.0 + a string method', () => {
    expect(isJsonRpcShape({ jsonrpc: '2.0', method: 'ping' })).toBe(true);
    expect(isJsonRpcShape({ jsonrpc: '2.0' })).toBe(false);
    expect(isJsonRpcShape({ method: 'ping' })).toBe(false);
    expect(isJsonRpcShape(null)).toBe(false);
  });
});
