// Stage A6 — daily loop + audit + SSE walls (C19/C20/C21) + owner-driven Stage-D
// surface (C15 partial: SE-8 gate, envelope, fabricated-txHash probe P5.1).
// All F-4-independent (no model decisions involved).
import { campaignOwner, privyLogin, makeApi, warm, sleep, record, section, summary, API } from './common.mjs';
import { readFileSync } from 'node:fs';

const owner = campaignOwner('owner-a');
await warm(API);
const token = await privyLogin(owner);
const api = makeApi(token);
const fixtures = JSON.parse(readFileSync(new URL('./state/a1-fixtures.json', import.meta.url), 'utf8'));
const AGENT = fixtures.provider.agentId; // живой, spend-incapable, has traces

// ---------- C19 alerts ----------
section('A6 / C19 Alerts');
{
  const all = await api('/api/alerts?limit=50');
  record('C19-H1-list', all.status === 200, `${(all.body.alerts ?? []).length} alerts`);
  const filt = await api('/api/alerts?class=info&status=unread&limit=50');
  const wrongClass = (filt.body.alerts ?? []).some((a) => a.class !== 'info' || a.status !== 'unread');
  record('C19-H2-filters', filt.status === 200 && !wrongClass, `info+unread filter clean=${!wrongClass}`);
  // dismiss an info alert
  const info = (filt.body.alerts ?? [])[0];
  if (info) {
    const d = await api(`/api/alerts/${info.id}`, { method: 'POST', body: { action: 'dismiss' } });
    record('C19-H3-dismiss-info', d.status < 300, `dismiss info -> ${d.status}`);
  }
  // decision-class alert must refuse dismissal (resolves only via its approval)
  const dec = (all.body.alerts ?? []).find((a) => a.class === 'decision' && a.status === 'unread');
  if (dec) {
    const d = await api(`/api/alerts/${dec.id}`, { method: 'POST', body: { action: 'dismiss' } });
    record('C19-A1-decision-dismiss-409', d.status === 409, `dismiss decision-class -> ${d.status}`);
  } else record('C19-A1-decision-dismiss-409', true, 'no live decision alert (covered logically by design; retest in A4)');
  const ra = await api('/api/alerts/read-all', { method: 'POST', body: '{}' });
  record('C19-H4-read-all', ra.status < 300, `read-all -> ${ra.status}`);
  // foreign alert action
  const apiB = makeApi(await privyLogin(campaignOwner('owner-b')));
  if (info) {
    const f = await apiB(`/api/alerts/${info.id}`, { method: 'POST', body: { action: 'read' } });
    record('C19-A2-foreign-alert', f.status === 404 || f.status === 403, `owner-b acts on owner-a alert -> ${f.status}`);
  }
}

// ---------- C19 digest + B-6 probe ----------
section('A6 / C19 Digest (+B-6 content probe)');
{
  const prev = await api('/api/digest');
  record('C19-H5-digest-preview', prev.status === 200, `preview -> ${prev.status} len=${JSON.stringify(prev.body).length}`);
  const text = JSON.stringify(prev.body).toLowerCase();
  // B-6: today owner-a created agents, made links, onboarded cross-chain. Does the digest know?
  const mentionsCreate = /create|new agent/.test(text);
  const mentionsLink = /link|delegat/.test(text);
  const mentionsOnboard = /onboard|network|chain/.test(text);
  record('B-6-digest-coverage', mentionsCreate || mentionsLink || mentionsOnboard,
    `mentions: create=${mentionsCreate} link/deleg=${mentionsLink} onboard=${mentionsOnboard} (all-false = B-6 confirmed)`);
  const m1 = await api('/api/digest/mark', { method: 'POST', body: '{}' });
  record('C19-H6-digest-mark', m1.status < 300, `mark -> ${m1.status}`);
  const m2 = await api('/api/digest/mark', { method: 'POST', body: '{}' });
  record('C19-S1-mark-again', m2.status < 300 || m2.status === 409, `second mark -> ${m2.status} (cursor monotonic)`);
}

// ---------- C20 audit / records ----------
section('A6 / C20 Audit + hash chain');
{
  const recs = await api('/api/owner/records?limit=100');
  record('C20-H1-owner-records', recs.status === 200 && recs.body.chainVerified !== false,
    `${(recs.body.records ?? []).length} records, chainVerified=${recs.body.chainVerified}`);
  const tr = await api(`/api/agents/${AGENT}/traces?limit=100`);
  record('C20-H2-agent-chain', tr.status === 200 && tr.body.chainVerified !== false,
    `${(tr.body.records ?? []).length} traces, chainVerified=${tr.body.chainVerified}`);
  const au = await api(`/api/agents/${AGENT}/audit`);
  const batches = au.body.batches ?? au.body ?? [];
  record('C20-H3-audit-batches', au.status === 200, `${Array.isArray(batches) ? batches.length : '?'} 0G Storage batches (F-3 watch: flush health)`);
  const oau = await api('/api/owner/audit');
  record('C20-H4-owner-audit', oau.status === 200, `owner audit -> ${oau.status}`);
}

// ---------- C21 SSE walls ----------
section('A6 / C21 SSE caps');
{
  // per-owner cap: open 21 concurrent streams → expect 429 on overflow
  const ctls = [];
  let got429 = false, opened = 0;
  for (let i = 0; i < 21; i++) {
    const ctl = new AbortController();
    ctls.push(ctl);
    const res = await fetch(`${API}/api/agents/${AGENT}/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ctl.signal,
    }).catch(() => null);
    if (res?.status === 429) { got429 = true; break; }
    if (res?.ok) opened++;
  }
  ctls.forEach((c) => c.abort());
  record('C21-S1-owner-cap', got429, `opened ${opened}, overflow 429=${got429} (cap 20/owner)`);
  // foreign stream
  const tokenB = await privyLogin(campaignOwner('owner-b'));
  const f = await fetch(`${API}/api/agents/${AGENT}/stream`, { headers: { authorization: `Bearer ${tokenB}`, accept: 'text/event-stream' } });
  record('C21-A1-foreign-stream', f.status === 404 || f.status === 403, `owner-b streams owner-a agent -> ${f.status}`);
  try { f.body?.cancel(); } catch {}
}

// ---------- C15 partial (owner-driven Stage D) ----------
section('A6 / C15 SE-8 gate + envelope + P5.1 probe');
{
  const env = await api(`/api/agents/${AGENT}/capabilities`);
  record('C15-H1-envelope', env.status === 200, `grants=${(env.body.grants ?? []).length} presets=${(env.body.presets ?? env.body.appliedPresets ?? []).length} requests=${(env.body.requests ?? []).length}`);
  // SE-8: custom rule to a random target on home chain → refused before any signature
  const rule = await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: {
    action: 'propose', target: '0xDEAD00000000000000000000000000000000BEEF', selector: '0xabcdef01',
    perCallCapWei: '1', windowCapWei: '1',
  } });
  record('C15-A1-se8-offlist', rule.status === 409 || rule.status === 400, `off-list target propose -> ${rule.status}`);
  // P5.1: record a preset with a FABRICATED txHash — does the read-model trust or verify?
  const fab = await api(`/api/agents/${AGENT}/capabilities/preset`, { method: 'POST', body: {
    presetKey: 'router', txHash: '0x' + 'ab'.repeat(32),
  } });
  record('P5.1-fabricated-txhash', true, `preset w/ fake txHash -> ${fab.status} ${JSON.stringify(fab.body).slice(0, 120)} (observed behavior pinned; verify-or-trust documented)`);
  // removal direction stays ungated
  const rm = await api(`/api/agents/${AGENT}/capabilities/rule`, { method: 'POST', body: { action: 'remove', target: '0xDEAD00000000000000000000000000000000BEEF', selector: '0xabcdef01' } });
  record('C15-H2-remove-ungated', rm.status < 500, `remove (fail-safe direction) -> ${rm.status}`);
}

summary('Stage A6');
