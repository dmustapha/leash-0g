import { describe, it, expect } from 'vitest';
import { parseEgressConfigFromEnv } from '../../src/gateway/mcp/egress.js';
import { isInternalHost, isInternalUrl, classifyTool } from '../../src/tool-use/tool-classify.js';
import { guardToolResult, guardToolArgs, DEFAULT_MAX_IO_BYTES } from '../../src/tool-use/tool-io-guard.js';
import type { ToolDescriptor, ToolGrantState } from '../../src/tool-use/types.js';

/**
 * SF-2 / SD-F7 — adversarial pass on the internet-facing gateway-exposure
 * surface the external bind opens: SSRF via MCP egress (C-SF3-1), poisoned tool
 * I/O (C-SF3-3 zero-width + wire-true byte cap), and the model-supplied url-role
 * exfil lane. The structural tenant isolation + auth checks live in the
 * integration suite (sf2-external-bind); this file hits the hardening predicates.
 */

describe('SF-2 SD-F7 — SSRF / internal-host egress guard (C-SF3-1)', () => {
  it('classifies the SSRF target set as internal (loopback/link-local/metadata/private)', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254', // cloud metadata
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '100.64.0.1', // CGNAT
      '::1',
      '[::1]',
      'fd00::1',
      'fe80::1',
      'foo.internal',
      'metadata.google.internal',
      // H-01 regressions: IPv4-mapped IPv6 (dotted + hex-group) + trailing-dot FQDN.
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe', // 169.254.169.254 in hex groups (new URL().hostname form)
      '::ffff:127.0.0.1',
      'metadata.google.internal.',
      'foo.internal.',
      '0:0:0:0:0:0:0:1', // non-compressed IPv6 loopback
      '', // empty → fail-closed internal
    ]) {
      expect(isInternalHost(h)).toBe(true);
    }
  });

  it('H-01: a bracketed IPv4-mapped IPv6 metadata URL is classified internal', () => {
    expect(isInternalUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toBe(true);
    expect(isInternalUrl('http://metadata.google.internal./computeMetadata/v1/')).toBe(true);
  });

  it('classifies real external hosts as NOT internal', () => {
    for (const h of ['api.openai.com', 'example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1']) {
      expect(isInternalHost(h)).toBe(false);
    }
    expect(isInternalUrl('https://api.anthropic.com/v1/messages')).toBe(false);
    expect(isInternalUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isInternalUrl('not a url')).toBe(true); // fail-closed
  });

  it('config-time: an internal egress allowlist origin THROWS at parse (fail-loud, no opt-in)', () => {
    expect(() =>
      parseEgressConfigFromEnv({ MCP_EGRESS_ALLOWLIST: 'http://169.254.169.254' }),
    ).toThrow(/internal\/loopback\/metadata/);
    expect(() =>
      parseEgressConfigFromEnv({
        MCP_SERVER_ENDPOINTS: JSON.stringify({ evil: 'http://127.0.0.1:9000/mcp' }),
      }),
    ).toThrow(/internal/);
  });

  it('config-time: opt-in (MCP_EGRESS_ALLOW_INTERNAL=true) permits internal origins (dev/[DEPLOY])', () => {
    const cfg = parseEgressConfigFromEnv({
      MCP_EGRESS_ALLOWLIST: 'http://127.0.0.1:9000',
      MCP_SERVER_ENDPOINTS: JSON.stringify({ echo: 'http://127.0.0.1:9000/mcp' }),
      MCP_EGRESS_ALLOW_INTERNAL: 'true',
    });
    expect(cfg.egressAllowlist).toContain('http://127.0.0.1:9000');
  });

  it('a real external allowlist parses clean', () => {
    const cfg = parseEgressConfigFromEnv({
      MCP_EGRESS_ALLOWLIST: 'https://mcp.example.com',
      MCP_SERVER_ENDPOINTS: JSON.stringify({ ex: 'https://mcp.example.com/rpc' }),
    });
    expect(cfg.egressAllowlist).toEqual(['https://mcp.example.com']);
  });
});

describe('SF-2 SD-F7 — model-supplied url-role arg always asks for an internal host (C-SF3-1)', () => {
  const descriptor: ToolDescriptor = {
    toolId: 'web.fetch',
    server: 'web',
    name: 'fetch',
    sensitive: false,
    authorityArgs: [{ name: 'url', role: 'url' }],
  };
  function grant(urlOriginAllowlist: string[]): ToolGrantState {
    return {
      rules: new Map([['web.fetch', { toolId: 'web.fetch', allowed: true, sensitive: false, perCallPolicy: { urlOriginAllowlist } }]]),
      egressAllowlist: new Set(['https://web.example']),
      serverEndpoints: new Map([['web', 'https://web.example/rpc']]),
    };
  }

  it('an allowlisted-origin url that resolves internal still escalates to L2 (ask)', () => {
    // Even if an operator allowlisted the origin, an internal host never fetches silently.
    const g = grant(['http://169.254.169.254']);
    const c = classifyTool({ toolId: 'web.fetch', args: { url: 'http://169.254.169.254/latest/meta-data' } }, descriptor, g);
    expect(c.lane).toBe('l2');
  });

  it('a normal external url in the allowlist is L1-silent', () => {
    const g = grant(['https://safe.example']);
    const c = classifyTool({ toolId: 'web.fetch', args: { url: 'https://safe.example/data.json' } }, descriptor, g);
    expect(c.lane).toBe('l1');
  });
});

describe('SF-2 SD-F7 — poisoned tool I/O (C-SF3-3)', () => {
  it('strips zero-width chars that fracture a dangerous token (ZWSP/ZWNJ/ZWJ/word-joiner)', () => {
    const poisoned = 'ex​fil‌tra‍te⁠now';
    const r = guardToolResult({ text: poisoned });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { text: string }).text).toBe('exfiltratenow');
  });

  it('NFC-normalizes decomposed sequences before the model reads them', () => {
    const decomposed = 'é'; // e + combining acute
    const r = guardToolResult({ s: decomposed });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { s: string }).s).toBe('é'.normalize('NFC'));
  });

  it('enforces the byte cap in UTF-8 BYTES, not UTF-16 length (multi-byte can’t sneak past)', () => {
    // 3-byte chars: .length under-counts by ~3×. Build a result just over the cap in BYTES.
    const multibyte = '界'.repeat(Math.ceil(DEFAULT_MAX_IO_BYTES / 3) + 100);
    expect(multibyte.length).toBeLessThan(DEFAULT_MAX_IO_BYTES); // would pass a .length cap
    const r = guardToolResult({ blob: multibyte });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversize');
  });

  it('still strips prototype-pollution keys at depth (regression guard)', () => {
    // JSON.parse (not an object literal) creates a REAL own `__proto__` key — an
    // object literal sets the prototype at parse time and never exercises the strip.
    const r = guardToolArgs(JSON.parse('{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":"x"}}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.prototype.hasOwnProperty.call(r.value, '__proto__')).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined(); // prototype not polluted
      // The own 'constructor' KEY is stripped (reading .constructor still finds
      // the inherited Object.constructor via the prototype chain — that's fine;
      // what matters is no attacker-supplied own-key rode through).
      const nested = (r.value as { nested: Record<string, unknown> }).nested;
      expect(Object.prototype.hasOwnProperty.call(nested, 'constructor')).toBe(false);
    }
  });
});
