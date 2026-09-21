import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Response } from 'express';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, testSettings, ownerAuth } from '../helpers/app.js';
import { AlertService } from '../../src/alerts/service.js';
import { getAlert, listAlerts } from '../../src/alerts/store.js';
import { listOwnerRecords, verifyOwnerChainIncremental, appendOwnerRecord } from '../../src/store/owner-records.js';
import { createApproval, getApproval } from '../../src/store/approvals.js';
import { createLink } from '../../src/coordination/store.js';
import { getAgentById } from '../../src/store/agents.js';
import { SseHub } from '../../src/sse/hub.js';

/**
 * D2 alert engine (spec §8 "Alert engine" row): taxonomy from real sources,
 * concurrent dedup upsert, auto-resolve on any channel, rate-guard storm
 * coalescing (nothing silently dropped), alert+record atomicity, and the
 * no-side-channel rule (alerts never mutate approvals except via the real
 * decision path). Plus D1 owner-stream fan-in and the §3d owner chain.
 */

let db: TestDb;
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0x9a' + String(ownerCounter++).padStart(4, '0') + 'ef'.repeat(17);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Minimal SSE sink standing in for an express Response. */
function sseSink(): { res: Response; frames: string[] } {
  const frames: string[] = [];
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    on: () => res,
  } as unknown as Response;
  return { res, frames };
}

describe('D2 — taxonomy kinds map from their real source events', () => {
  it('supervised handoff issuance → approval_required (decision, with approvalId + delegationId refs)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'issuer' });
    const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'receiver' });
    await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'supervised' });
    const from = await getAgentById(db.pool, fromId);
    if (!from) throw new Error('issuer missing');
    await t.coordinator.issueDelegation({ fromAgent: from, kind: 'task', payload: {} });
    const { alerts } = await listAlerts(db.pool, owner, { kind: 'approval_required' });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    if (!alert) throw new Error('alert missing');
    expect(alert.class).toBe('decision');
    expect(alert.status).toBe('unread');
    expect(alert.refs.approvalId).toBeDefined();
    expect(alert.refs.delegationId).toBeDefined();
    expect(alert.agentId).toBe(fromId);
  });

  it('guardian revoke → revoked (info); forced revert → revoke_failed with steer', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const okId = await seedAgent(db.pool, { ownerAddr: owner, name: 'revokes-fine' });
    const badId = await seedAgent(db.pool, {
      ownerAddr: owner,
      name: 'revoke-breaks',
      accountAddr: '0x' + 'e7'.repeat(20),
    });
    t.chain.revokeErrorFor.add(('0x' + 'e7'.repeat(20)).toLowerCase());

    const ok = await request(t.app).post(`/api/agents/${okId}/revoke`).set('authorization', ownerAuth(owner));
    expect(ok.status).toBe(200);
    const bad = await request(t.app).post(`/api/agents/${badId}/revoke`).set('authorization', ownerAuth(owner));
    expect(bad.status).toBe(502);

    const revoked = await listAlerts(db.pool, owner, { kind: 'revoked' });
    expect(revoked.alerts).toHaveLength(1);
    expect(revoked.alerts[0]?.agentId).toBe(okId);
    const failed = await listAlerts(db.pool, owner, { kind: 'revoke_failed' });
    expect(failed.alerts).toHaveLength(1);
    expect(failed.alerts[0]?.agentId).toBe(badId);
    expect(failed.alerts[0]?.summary).toContain('owner wallet');
  });

  it('link pause cancelling an envelope → delegation_terminal (info, one per envelope)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'a' });
    const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'b' });
    const link = await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'auto' });
    const from = await getAgentById(db.pool, fromId);
    if (!from) throw new Error('issuer missing');
    const d = await t.coordinator.issueDelegation({ fromAgent: from, kind: 'task', payload: {} });
    await t.coordinator.cancelForLink(link.id, 'link paused by owner');
    const { alerts } = await listAlerts(db.pool, owner, { kind: 'delegation_terminal' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.refs.delegationId).toBe(d.id);
    expect(alerts[0]?.class).toBe('info');
  });

  it('channel throttle rejection → throttle (info, coalesced per agent/reason/hour)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool, { settings: testSettings({ delegationMaxPendingPerLink: 1 }) });
    const fromId = await seedAgent(db.pool, { ownerAddr: owner, name: 'spammy' });
    const toId = await seedAgent(db.pool, { ownerAddr: owner, name: 'target' });
    await createLink(db.pool, { ownerAddr: owner, fromAgentId: fromId, toAgentId: toId, mode: 'auto' });
    const from = await getAgentById(db.pool, fromId);
    if (!from) throw new Error('issuer missing');
    await t.coordinator.issueDelegation({ fromAgent: from, kind: 'task', payload: {} });
    for (let i = 0; i < 3; i++) {
      await t.coordinator.issueDelegation({ fromAgent: from, kind: 'task', payload: {} }).catch(() => undefined);
    }
    const { alerts } = await listAlerts(db.pool, owner, { kind: 'throttle' });
    expect(alerts).toHaveLength(1); // coalesced
    expect(alerts[0]?.count).toBe(3);
  });
});

describe('D2 — dedup, resolve, storm, atomicity', () => {
  it('CONCURRENT same-dedup-key emits land as ONE row with count incremented', async () => {
    const owner = uniqueOwner();
    const hub = new SseHub();
    const svc = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        svc.emit(owner, {
          class: 'info',
          kind: 'runtime_error',
          summary: 'boom',
          dedupKey: 'runtime_error:x:bucket',
        }),
      ),
    );
    const { alerts } = await listAlerts(db.pool, owner, { kind: 'runtime_error' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.count).toBe(6);
  });

  it('decision alert auto-resolves on app-decide with resolvedVia recorded', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'decider' });
    const approval = await createApproval(db.pool, agentId, { kind: 'transfer' });
    await t.alerts.emit(owner, {
      agentId,
      class: 'decision',
      kind: 'approval_required',
      summary: 'needs you',
      refs: { approvalId: approval.id },
    });
    const res = await request(t.app)
      .post(`/api/approvals/${approval.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);
    const { alerts } = await listAlerts(db.pool, owner, { kind: 'approval_required' });
    expect(alerts[0]?.status).toBe('resolved');
    expect(alerts[0]?.resolution).toBe('approve');
    expect(alerts[0]?.resolvedVia).toBe('app');
    // The alert_resolved owner record references the approval, not duplicated authority.
    const records = await listOwnerRecords(db.pool, owner);
    const resolvedRec = records.find((r) => r.kind === 'alert_resolved');
    expect(resolvedRec).toBeDefined();
    expect((resolvedRec?.record as { approvalId?: string }).approvalId).toBe(approval.id);
  });

  it('rate guard trips into ONE coalescing alert_storm row + owner-record trace (nothing silently dropped)', async () => {
    const owner = uniqueOwner();
    const hub = new SseHub();
    const svc = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 3 } });
    for (let i = 0; i < 8; i++) {
      await svc.emit(owner, { class: 'info', kind: 'runtime_error', summary: `e${i}` });
    }
    const all = await listAlerts(db.pool, owner, {});
    const storm = all.alerts.filter((a) => a.kind === 'alert_storm');
    expect(storm).toHaveLength(1);
    // 3 admitted; the 5 guarded emissions ALL fold into the durable storm row
    // (its count is the folded total — nothing lost from the alert row).
    expect(storm[0]?.count).toBe(5);
    const records = await listOwnerRecords(db.pool, owner);
    const stormRecords = records.filter(
      (r) => (r.record as { kind?: string }).kind === 'alert_storm',
    );
    // Owner stream records the TRIP only (plus a periodic counter every 50th
    // fold) — the storm must not amplify the append-only stream.
    expect(stormRecords.length).toBe(1);
    expect((stormRecords[0]?.record as { count?: number }).count).toBe(1);
    const verdict = await verifyOwnerChainIncremental(db.pool, owner);
    expect(verdict.ok).toBe(true);
  });

  it('alert row + owner record commit atomically even when SSE fan-out throws', async () => {
    const owner = uniqueOwner();
    const hub = new SseHub();
    (hub as unknown as { emitOwner: () => void }).emitOwner = () => {
      throw new Error('fan-out exploded');
    };
    const svc = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
    const alert = await svc.emit(owner, { class: 'info', kind: 'revoked', summary: 'gone' });
    // emit swallows the edge failure; BOTH durable writes exist.
    const stored = alert ? await getAlert(db.pool, alert.id) : null;
    const records = await listOwnerRecords(db.pool, owner);
    expect(stored).not.toBeNull();
    expect(records.filter((r) => r.kind === 'alert')).toHaveLength(1);
  });

  it('alerts never mutate approval state outside the real decision path (dismiss of approval_required → 409)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'guarded' });
    const approval = await createApproval(db.pool, agentId, { kind: 'transfer' });
    const alert = await t.alerts.emit(owner, {
      agentId,
      class: 'decision',
      kind: 'approval_required',
      summary: 'needs you',
      refs: { approvalId: approval.id },
    });
    if (!alert) throw new Error('emit failed');
    const res = await request(t.app)
      .post(`/api/alerts/${alert.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ action: 'dismiss' });
    expect(res.status).toBe(409);
    expect((await getApproval(db.pool, approval.id))?.state).toBe('pending'); // untouched
    expect((await getAlert(db.pool, alert.id))?.status).toBe('unread');
  });

  it('read/dismiss lifecycle + read-all touches only open INFO alerts', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'lifecycle' });
    const approval = await createApproval(db.pool, agentId, { kind: 'transfer' });
    const decision = await t.alerts.emit(owner, {
      agentId,
      class: 'decision',
      kind: 'approval_required',
      summary: 'decide me',
      refs: { approvalId: approval.id },
    });
    const info = await t.alerts.emit(owner, { agentId, class: 'info', kind: 'revoked', summary: 'fyi' });
    if (!decision || !info) throw new Error('emit failed');
    const bulk = await request(t.app).post('/api/alerts/read-all').set('authorization', ownerAuth(owner)).send({});
    expect(bulk.body.marked).toBe(1); // only the info alert
    expect((await getAlert(db.pool, decision.id))?.status).toBe('unread');
    expect((await getAlert(db.pool, info.id))?.status).toBe('read');
    const dismissed = await request(t.app)
      .post(`/api/alerts/${info.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ action: 'dismiss' });
    expect(dismissed.status).toBe(200);
    expect((await getAlert(db.pool, info.id))?.status).toBe('dismissed');
  });

  it('foreign owner cannot read or act on another owner’s alert (404, no oracle)', async () => {
    const owner = uniqueOwner();
    const stranger = uniqueOwner();
    const t = buildTestApp(db.pool);
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'private' });
    const alert = await t.alerts.emit(owner, { agentId, class: 'info', kind: 'revoked', summary: 's' });
    if (!alert) throw new Error('emit failed');
    const res = await request(t.app)
      .post(`/api/alerts/${alert.id}`)
      .set('authorization', ownerAuth(stranger))
      .send({ action: 'read' });
    expect(res.status).toBe(404);
    const list = await request(t.app).get('/api/alerts').set('authorization', ownerAuth(stranger));
    expect(list.body.alerts).toHaveLength(0);
  });
});

describe('D1 — owner aggregate stream', () => {
  it('multi-agent fan-in: events from BOTH agents arrive tagged agentId; reasoning excluded; per-agent unchanged', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const a = await seedAgent(db.pool, { ownerAddr: owner, name: 'agent-a' });
    const b = await seedAgent(db.pool, { ownerAddr: owner, name: 'agent-b' });
    const ownerSink = sseSink();
    const agentSink = sseSink();
    t.hub.attachOwner(owner, ownerSink.res);
    t.hub.attach(a, agentSink.res);

    t.hub.emit(a, 'status', { type: 'status', status: 'running' });
    t.hub.emit(b, 'trace', { type: 'trace', kind: 'action' });
    t.hub.emit(a, 'reasoning', { type: 'reasoning', text: 'thinking...' });
    // Owner fan-out resolves the agent→owner mapping asynchronously (Neon
    // roundtrip on first lookup) — poll, don't guess a delay.
    await waitFor(() =>
      ownerSink.frames.some((f) => f.includes(a)) && ownerSink.frames.some((f) => f.includes(b)),
    );

    const ownerPayloads = ownerSink.frames.filter((f) => f.includes('agent_event'));
    expect(ownerPayloads.some((f) => f.includes(a) && f.includes('"status"'))).toBe(true);
    expect(ownerPayloads.some((f) => f.includes(b) && f.includes('"trace"'))).toBe(true);
    expect(ownerSink.frames.some((f) => f.includes('reasoning'))).toBe(false); // volume exclusion
    // Per-agent stream still gets everything, including reasoning.
    expect(agentSink.frames.some((f) => f.includes('reasoning'))).toBe(true);
  });

  it('a foreign owner’s sink receives nothing (channel keying is the isolation)', async () => {
    const owner = uniqueOwner();
    const stranger = uniqueOwner();
    const t = buildTestApp(db.pool);
    const a = await seedAgent(db.pool, { ownerAddr: owner, name: 'mine' });
    const strangerSink = sseSink();
    t.hub.attachOwner(stranger, strangerSink.res);
    t.hub.emit(a, 'status', { type: 'status', status: 'running' });
    await new Promise((r) => setTimeout(r, 1000));
    expect(strangerSink.frames.filter((f) => f.includes('agent_event'))).toHaveLength(0);
  });

  it('alert emission delivers an owner-level alert frame', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const sink = sseSink();
    t.hub.attachOwner(owner, sink.res);
    await t.alerts.emit(owner, { class: 'info', kind: 'revoked', summary: 'gone' });
    expect(sink.frames.some((f) => f.includes('"type":"alert"'))).toBe(true);
  });
});

describe('§3d — owner-stream records + routes', () => {
  it('concurrent multi-source emission keeps the owner chain gapless and verifiable', async () => {
    const owner = uniqueOwner();
    const hub = new SseHub();
    const svc = new AlertService({ pool: db.pool, hub, settings: { alertRatePerOwnerPerHour: 1000 } });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => svc.emit(owner, { class: 'info', kind: 'revoked', summary: `r${i}` })),
      ...Array.from({ length: 5 }, (_, i) => appendOwnerRecord(db.pool, owner, 'digest', { n: i })),
    ]);
    const records = await listOwnerRecords(db.pool, owner);
    expect(records).toHaveLength(10);
    expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    const verdict = await verifyOwnerChainIncremental(db.pool, owner);
    expect(verdict.ok).toBe(true);
  });

  it('owner_records is append-only (UPDATE and DELETE rejected by trigger)', async () => {
    const owner = uniqueOwner();
    await appendOwnerRecord(db.pool, owner, 'alert', { x: 1 });
    await expect(
      db.pool.query(`UPDATE owner_records SET kind = 'digest' WHERE owner_addr = $1`, [owner.toLowerCase()]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.pool.query(`DELETE FROM owner_records WHERE owner_addr = $1`, [owner.toLowerCase()]),
    ).rejects.toThrow(/append-only/);
  });

  it('GET /api/owner/records pages with chainVerified', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    await t.alerts.emit(owner, { class: 'info', kind: 'revoked', summary: 'one' });
    await t.alerts.emit(owner, { class: 'info', kind: 'revoked', summary: 'two' });
    const res = await request(t.app).get('/api/owner/records').set('authorization', ownerAuth(owner));
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(2);
    expect(res.body.chainVerified).toBe(true);
  });
});

describe('owner settings', () => {
  it('PATCH prefs + digest hour round-trips; stream pubkey is set-once (409 on overwrite)', async () => {
    const owner = uniqueOwner();
    const t = buildTestApp(db.pool);
    const key1 = '02' + 'aa'.repeat(32);
    const key2 = '02' + 'bb'.repeat(32);
    const first = await request(t.app)
      .patch('/api/owner/settings')
      .set('authorization', ownerAuth(owner))
      .send({ alertPrefs: { revoked: { telegram: true } }, digestHourUtc: 9, streamPubkey: key1 });
    expect(first.status).toBe(200);
    expect(first.body.streamPubkeySet).toBe(true);
    const read = await request(t.app).get('/api/owner/settings').set('authorization', ownerAuth(owner));
    expect(read.body.digestHourUtc).toBe(9);
    expect(read.body.alertPrefs.revoked.telegram).toBe(true);
    const overwrite = await request(t.app)
      .patch('/api/owner/settings')
      .set('authorization', ownerAuth(owner))
      .send({ streamPubkey: key2 });
    expect(overwrite.status).toBe(409);
  });
});
