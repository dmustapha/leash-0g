import { describe, it, expect } from 'vitest';
import {
  classifyTool,
  defaultToolRegistry,
  expandToolPreset,
  toolPresetKeys,
  originOf,
  type ToolGrantState,
  type ToolRule,
} from '../../src/tool-use/index.js';

const ENDPOINT = 'https://mcp.example.com/v1';
const ORIGIN = 'https://mcp.example.com';

function grant(rules: ToolRule[], opts?: { servers?: Record<string, string>; egress?: string[] }): ToolGrantState {
  const servers = opts?.servers ?? {
    search: ENDPOINT,
    fetch: ENDPOINT,
    email: ENDPOINT,
    slack: ENDPOINT,
    fs: ENDPOINT,
    payments: ENDPOINT,
  };
  return {
    rules: new Map(rules.map((r) => [r.toolId.toLowerCase(), r])),
    egressAllowlist: new Set(opts?.egress ?? [ORIGIN]),
    serverEndpoints: new Map(Object.entries(servers)),
  };
}

const allow = (toolId: string, extra?: Partial<ToolRule>): ToolRule => ({
  toolId,
  allowed: true,
  sensitive: false,
  ...extra,
});

describe('classifyTool — three-lane, grant-state only (mirror of governed-call classify)', () => {
  it('allowlisted non-sensitive tool within policy → L1 silent', () => {
    const g = grant([allow('search.web_search')]);
    const c = classifyTool({ toolId: 'search.web_search', args: { query: 'hi' } }, defaultToolRegistry.get('search.web_search'), g);
    expect(c).toEqual({ lane: 'l1', reason: 'in_policy' });
  });

  it('a non-allowlisted tool is FORBIDDEN (default-deny), even if the registry knows it', () => {
    const g = grant([]); // no rule
    const c = classifyTool({ toolId: 'search.web_search', args: {} }, defaultToolRegistry.get('search.web_search'), g);
    expect(c).toEqual({ lane: 'forbidden', reason: 'not_allowlisted' });
  });

  it('an explicit allowed:false rule is FORBIDDEN', () => {
    const g = grant([{ toolId: 'search.web_search', allowed: false, sensitive: false }]);
    const c = classifyTool({ toolId: 'search.web_search', args: {} }, defaultToolRegistry.get('search.web_search'), g);
    expect(c).toEqual({ lane: 'forbidden', reason: 'not_allowlisted' });
  });

  it('an unknown tool (no descriptor) is FORBIDDEN, never guessed', () => {
    const g = grant([allow('ghost.tool')]);
    const c = classifyTool({ toolId: 'ghost.tool', args: {} }, undefined, g);
    expect(c).toEqual({ lane: 'forbidden', reason: 'unknown_tool' });
  });

  it('a sensitive tool ALWAYS raises L2, regardless of a standing allow (00 §6c)', () => {
    const g = grant([allow('email.send_email')]);
    const c = classifyTool({ toolId: 'email.send_email', args: { to: 'a@b.com' } }, defaultToolRegistry.get('email.send_email'), g);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.triggers).toContain('sensitive');
  });

  it('owner-escalated sensitivity on a non-sensitive descriptor → L2', () => {
    const g = grant([allow('search.web_search', { sensitive: true })]);
    const c = classifyTool({ toolId: 'search.web_search', args: {} }, defaultToolRegistry.get('search.web_search'), g);
    expect(c.lane).toBe('l2');
  });

  it('a recipient outside the per-call recipient allowlist → L2 new_recipient', () => {
    const g = grant([
      allow('email.send_email', { perCallPolicy: { recipientAllowlist: ['ok@leash.dev'] } }),
    ]);
    const c = classifyTool({ toolId: 'email.send_email', args: { to: 'evil@attacker.com' } }, defaultToolRegistry.get('email.send_email'), g);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.triggers).toEqual(expect.arrayContaining(['sensitive', 'new_recipient']));
  });

  it('SEC M-01: a url-role arg with NO url-origin allowlist ALWAYS asks (L2 new_url), never silent egress', () => {
    const g = grant([allow('fetch.fetch_url')]);
    const c = classifyTool({ toolId: 'fetch.fetch_url', args: { url: 'http://169.254.169.254/latest/meta-data' } }, defaultToolRegistry.get('fetch.fetch_url'), g);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.triggers).toContain('new_url');
  });

  it('SEC M-01: a url-role arg whose origin IS in the per-call allowlist is L1-silent', () => {
    const g = grant([allow('fetch.fetch_url', { perCallPolicy: { urlOriginAllowlist: ['https://api.ok.com'] } })]);
    const c = classifyTool({ toolId: 'fetch.fetch_url', args: { url: 'https://api.ok.com/data?q=1' } }, defaultToolRegistry.get('fetch.fetch_url'), g);
    expect(c).toEqual({ lane: 'l1', reason: 'in_policy' });
  });

  it('SEC M-01: a url-role arg off the allowlist → L2 new_url', () => {
    const g = grant([allow('fetch.fetch_url', { perCallPolicy: { urlOriginAllowlist: ['https://api.ok.com'] } })]);
    const c = classifyTool({ toolId: 'fetch.fetch_url', args: { url: 'http://evil.attacker.com/collect' } }, defaultToolRegistry.get('fetch.fetch_url'), g);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.triggers).toContain('new_url');
  });

  it('over per-call arg size → L2 over_arg_size', () => {
    const g = grant([allow('search.web_search', { perCallPolicy: { maxArgBytes: 10 } })]);
    const c = classifyTool({ toolId: 'search.web_search', args: { query: 'a very long query that exceeds ten bytes' } }, defaultToolRegistry.get('search.web_search'), g);
    expect(c.lane).toBe('l2');
    if (c.lane === 'l2') expect(c.triggers).toContain('over_arg_size');
  });

  it('server with NO configured endpoint → FORBIDDEN egress_not_allowlisted', () => {
    const g = grant([allow('search.web_search')], { servers: {} });
    const c = classifyTool({ toolId: 'search.web_search', args: {} }, defaultToolRegistry.get('search.web_search'), g);
    expect(c).toEqual({ lane: 'forbidden', reason: 'egress_not_allowlisted' });
  });

  it('endpoint ORIGIN off the egress allowlist → FORBIDDEN (SSRF/egress guard)', () => {
    const g = grant([allow('search.web_search')], { egress: ['https://other.example.com'] });
    const c = classifyTool({ toolId: 'search.web_search', args: {} }, defaultToolRegistry.get('search.web_search'), g);
    expect(c).toEqual({ lane: 'forbidden', reason: 'egress_not_allowlisted' });
  });

  it('a tool RESULT cannot widen the allowlist — classify ignores any extra arg keys', () => {
    // A poisoned result might try to smuggle a "capabilities"/"allow" field into
    // a follow-up call's args; classify reads grant-state only, so it has no effect.
    const g = grant([]); // nothing granted
    const c = classifyTool(
      { toolId: 'search.web_search', args: { allow: true, capabilities: ['search.web_search'] } },
      defaultToolRegistry.get('search.web_search'),
      g,
    );
    expect(c).toEqual({ lane: 'forbidden', reason: 'not_allowlisted' });
  });
});

describe('originOf — fail-closed URL origin', () => {
  it('parses scheme://host[:port], lowercased', () => {
    expect(originOf('https://Mcp.Example.com:8443/x')).toBe('https://mcp.example.com:8443');
  });
  it('returns null for an unparseable URL', () => {
    expect(originOf('not a url')).toBeNull();
  });
});

describe('expandToolPreset — broad-grant UX, sensitive stays always-ask', () => {
  it('every preset resolves against the default registry', () => {
    for (const key of toolPresetKeys()) {
      const r = expandToolPreset(key);
      expect(r, key).not.toBeNull();
      expect(r!.rules.length).toBeGreaterThan(0);
    }
  });

  it('researcher grants only read-only, non-sensitive tools', () => {
    const r = expandToolPreset('researcher')!;
    expect(r.rules.every((x) => x.allowed && !x.sensitive)).toBe(true);
  });

  it('communicator includes send tools but marks them sensitive (never silent)', () => {
    const r = expandToolPreset('communicator')!;
    const email = r.rules.find((x) => x.toolId === 'email.send_email')!;
    expect(email.sensitive).toBe(true);
    // And a granted sensitive tool still classifies L2:
    const g = grant(r.rules);
    const c = classifyTool({ toolId: 'email.send_email', args: { to: 'x@y.z' } }, defaultToolRegistry.get('email.send_email'), g);
    expect(c.lane).toBe('l2');
  });
});
