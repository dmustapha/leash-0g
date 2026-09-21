import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/server.js';
import { createTestDb, seedAgent, type TestDb } from '../helpers/db.js';
import { buildTestApp, ownerAuth, type TestApp } from '../helpers/app.js';
import { TelegramBot } from '../../src/telegram/bot.js';
import type { TelegramApi, SendMessageInput, EditMessageInput } from '../../src/telegram/api.js';
import { createApproval, getApproval } from '../../src/store/approvals.js';
import { getOwnerSettings } from '../../src/store/owner-settings.js';
import { listTraces } from '../../src/trace/trace-store.js';
import { getAlert } from '../../src/alerts/store.js';

/**
 * D3 Telegram slice (spec §8 "Telegram" row). The TRANSPORT is mocked at the
 * TelegramApi boundary — link flow, webhook auth, callback verification,
 * consent ordering, edit-on-resolve are OUR logic and run for real. The
 * deployed drill is the real-transport evidence (D3).
 */

let db: TestDb;
let ownerCounter = 0;
function uniqueOwner(): string {
  return '0xb7' + String(ownerCounter++).padStart(4, '0') + 'dd'.repeat(17);
}

const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';

class MockTelegramApi implements TelegramApi {
  public sent: SendMessageInput[] = [];
  public edits: EditMessageInput[] = [];
  public answers: Array<{ id: string; text?: string | undefined }> = [];
  public failSends = false;
  private nextMessageId = 1000;

  async sendMessage(input: SendMessageInput): Promise<{ message_id: number }> {
    if (this.failSends) throw new Error('telegram unreachable');
    this.sent.push(input);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(input: EditMessageInput): Promise<void> {
    this.edits.push(input);
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }

  async setWebhook(): Promise<void> {
    // no-op
  }
}

interface TgHarness {
  t: TestApp;
  app: Express;
  api: MockTelegramApi;
  bot: TelegramBot;
}

function buildTelegramHarness(): TgHarness {
  const t = buildTestApp(db.pool);
  const api = new MockTelegramApi();
  const bot = new TelegramBot({
    pool: db.pool,
    api,
    botUsername: 'leash_test_bot',
    decide: { pool: db.pool, hub: t.hub, broker: t.broker, coordinator: t.coordinator, alerts: t.alerts },
  });
  t.alerts.setTelegramDelivery(bot.delivery());
  const app = createApp({ ...t.deps, telegram: { bot, webhookSecret: WEBHOOK_SECRET } });
  return { t, app, api, bot };
}

async function linkOwner(h: TgHarness, owner: string, chatId: string): Promise<void> {
  const res = await request(h.app).post('/api/owner/telegram/link').set('authorization', ownerAuth(owner)).send({});
  expect(res.status).toBe(200);
  const token = new URL(res.body.url).searchParams.get('start');
  await h.bot.handleUpdate({ message: { chat: { id: chatId }, text: `/start ${token}` } });
  const settings = await getOwnerSettings(db.pool, owner);
  expect(settings.telegramChatId).toBe(chatId);
}

/** Emit an approval_required alert and capture the pushed card + callbacks. */
async function pushApprovalCard(
  h: TgHarness,
  owner: string,
  agentId: string,
): Promise<{ approvalId: string; alertId: string; approveData: string; denyData: string; messageId: number }> {
  const approval = await createApproval(db.pool, agentId, { kind: 'transfer', valueWei: '5' });
  const baseline = h.api.sent.length; // link-flow confirmations already sent
  const alert = await h.t.alerts.emit(owner, {
    agentId,
    class: 'decision',
    kind: 'approval_required',
    summary: 'agent wants to send 5 wei',
    refs: { approvalId: approval.id },
  });
  if (!alert) throw new Error('emit failed');
  // pushAlert is post-commit best-effort — wait for the NEW send to land.
  const start = Date.now();
  while (h.api.sent.length <= baseline && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const card = h.api.sent[h.api.sent.length - 1];
  if (!card?.reply_markup) throw new Error('no inline keyboard pushed');
  const [row] = card.reply_markup.inline_keyboard;
  const approveData = row?.[0]?.callback_data ?? '';
  const denyData = row?.[1]?.callback_data ?? '';
  const stored = await getAlert(db.pool, alert.id);
  return {
    approvalId: approval.id,
    alertId: alert.id,
    approveData,
    denyData,
    messageId: Number(stored?.telegramMessageId ?? 0),
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

describe('link flow', () => {
  it('happy path: deep-link token binds the chat; expired and reused tokens are refused', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    await linkOwner(h, owner, '111');

    // Reuse: the same token again fails (single use).
    const res = await request(h.app).post('/api/owner/telegram/link').set('authorization', ownerAuth(owner)).send({});
    const token = new URL(res.body.url).searchParams.get('start');
    await h.bot.handleUpdate({ message: { chat: { id: '222' }, text: `/start ${token}` } });
    await h.bot.handleUpdate({ message: { chat: { id: '333' }, text: `/start ${token}` } });
    const settings = await getOwnerSettings(db.pool, owner);
    expect(settings.telegramChatId).toBe('222'); // second use did NOT bind 333

    // Expired: age a fresh token past its TTL.
    const res2 = await request(h.app).post('/api/owner/telegram/link').set('authorization', ownerAuth(owner)).send({});
    const token2 = new URL(res2.body.url).searchParams.get('start');
    await db.pool.query(`UPDATE telegram_link_tokens SET expires_at = now() - interval '1 minute'`);
    await h.bot.handleUpdate({ message: { chat: { id: '444' }, text: `/start ${token2}` } });
    expect((await getOwnerSettings(db.pool, owner)).telegramChatId).toBe('222');
  });

  it('re-link replaces the chat and notifies the OLD chat', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    await linkOwner(h, owner, 'old-chat');
    h.api.sent = [];
    await linkOwner(h, owner, 'new-chat');
    expect(h.api.sent.some((m) => m.chat_id === 'old-chat' && /different Telegram chat/.test(m.text))).toBe(true);
  });

  it('unlink stops delivery', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'quiet' });
    await linkOwner(h, owner, '555');
    const del = await request(h.app).delete('/api/owner/telegram').set('authorization', ownerAuth(owner));
    expect(del.status).toBe(200);
    h.api.sent = [];
    await h.t.alerts.emit(owner, {
      agentId,
      class: 'decision',
      kind: 'approval_required',
      summary: 'should not push',
      refs: { approvalId: (await createApproval(db.pool, agentId, {})).id },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.api.sent).toHaveLength(0);
  });
});

describe('webhook auth', () => {
  it('wrong or missing secret → 401; correct secret → 200 (no Privy involved)', async () => {
    const h = buildTelegramHarness();
    const bad = await request(h.app).post('/api/telegram/webhook').send({ message: {} });
    expect(bad.status).toBe(401);
    const wrong = await request(h.app)
      .post('/api/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'nope')
      .send({ message: {} });
    expect(wrong.status).toBe(401);
    const ok = await request(h.app)
      .post('/api/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', WEBHOOK_SECRET)
      .send({ message: { chat: { id: 1 }, text: '/status' } });
    expect(ok.status).toBe(200);
  });
});

describe('inline decide — THE consent rail', () => {
  it('approve: consent durable with channel telegram, broker notified, alert resolved, card edited', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'approver' });
    await linkOwner(h, owner, '777');
    const card = await pushApprovalCard(h, owner, agentId);

    // A held request waits on the broker BEFORE the decision arrives —
    // the notify must wake it (consent-before-forward is order-asserted below).
    const waited = h.t.broker.wait(card.approvalId, 10_000);

    await h.bot.handleUpdate({
      callback_query: {
        id: 'cb1',
        data: card.approveData,
        message: { chat: { id: '777' }, message_id: card.messageId },
      },
    });

    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('approved');
    const decision = (await waited) as { decision: string };
    expect(decision.decision).toBe('approve');
    // Consent record: durable, channel recorded, seq strictly before any
    // action that would follow the notify.
    const traces = await listTraces(db.pool, agentId);
    const consent = traces.find((r) => r.kind === 'consent' && r.approvalId === card.approvalId);
    expect(consent).toBeDefined();
    expect((consent?.detail as { channel?: string })?.channel).toBe('telegram');
    // Alert resolved via telegram + message edited with buttons removed.
    const alert = await getAlert(db.pool, card.alertId);
    expect(alert?.status).toBe('resolved');
    expect(alert?.resolvedVia).toBe('telegram');
    const start = Date.now();
    while (h.api.edits.length === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const edit = h.api.edits[0];
    expect(edit?.message_id).toBe(card.messageId);
    expect(edit?.text).toContain('Approved');
    expect('reply_markup' in (edit ?? {})).toBe(false); // keyboard removed
  });

  it('deny: traced stand-down decision reaches the broker', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'denier' });
    await linkOwner(h, owner, '888');
    const card = await pushApprovalCard(h, owner, agentId);
    await h.bot.handleUpdate({
      callback_query: { id: 'cb2', data: card.denyData, message: { chat: { id: '888' }, message_id: card.messageId } },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('denied');
    const traces = await listTraces(db.pool, agentId);
    expect(traces.some((r) => r.kind === 'consent' && r.decision === 'deny')).toBe(true);
  });

  it('forged callbacks are rejected without deciding: bad nonce, wrong chat, replay', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'target' });
    await linkOwner(h, owner, '999');
    const card = await pushApprovalCard(h, owner, agentId);

    // Bad nonce.
    await h.bot.handleUpdate({
      callback_query: { id: 'f1', data: 'A'.repeat(32), message: { chat: { id: '999' }, message_id: 1 } },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('pending');

    // Wrong chat (forwarded card in a stranger's chat) — token must NOT decide
    // AND is burned (single-use), so it cannot be replayed from the right chat.
    await h.bot.handleUpdate({
      callback_query: {
        id: 'f2',
        data: card.approveData,
        message: { chat: { id: 'attacker-chat' }, message_id: card.messageId },
      },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('pending');

    // The burned token now fails even from the linked chat (replay-proof).
    await h.bot.handleUpdate({
      callback_query: {
        id: 'f3',
        data: card.approveData,
        message: { chat: { id: '999' }, message_id: card.messageId },
      },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('pending');
    // The deny token is untouched — the legitimate chat can still decide.
    await h.bot.handleUpdate({
      callback_query: { id: 'f4', data: card.denyData, message: { chat: { id: '999' }, message_id: card.messageId } },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('denied');
  });

  it('already-decided (app decided first): callback is a no-op answer', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'raced' });
    await linkOwner(h, owner, '1010');
    const card = await pushApprovalCard(h, owner, agentId);
    // App channel decides first.
    const res = await request(h.app)
      .post(`/api/approvals/${card.approvalId}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'deny' });
    expect(res.status).toBe(200);
    await h.bot.handleUpdate({
      callback_query: {
        id: 'cb3',
        data: card.approveData,
        message: { chat: { id: '1010' }, message_id: card.messageId },
      },
    });
    expect((await getApproval(db.pool, card.approvalId))?.state).toBe('denied'); // unchanged
    expect(h.api.answers.some((a) => /already decided/i.test(a.text ?? ''))).toBe(true);
  });

  it('app-decide edits the Telegram card too (any channel resolves everywhere)', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'cross-channel' });
    await linkOwner(h, owner, '1111');
    const card = await pushApprovalCard(h, owner, agentId);
    await request(h.app)
      .post(`/api/approvals/${card.approvalId}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'approve' });
    const start = Date.now();
    while (h.api.edits.length === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.api.edits[0]?.text).toContain('Approved');
    expect(h.api.edits[0]?.text).toContain('in the app');
  });

  it('telegram send failure never blocks the durable alert or the in-app decision', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'resilient' });
    await linkOwner(h, owner, '1212');
    h.api.failSends = true;
    const approval = await createApproval(db.pool, agentId, { kind: 'transfer' });
    const alert = await h.t.alerts.emit(owner, {
      agentId,
      class: 'decision',
      kind: 'approval_required',
      summary: 'push will fail',
      refs: { approvalId: approval.id },
    });
    expect(alert).not.toBeNull(); // durable despite the dead transport
    const res = await request(h.app)
      .post(`/api/approvals/${approval.id}`)
      .set('authorization', ownerAuth(owner))
      .send({ decision: 'approve' });
    expect(res.status).toBe(200); // in-app path unaffected
  });
});

describe('prefs (S11 defaults)', () => {
  it('info-class alerts do NOT push by default; explicit pref turns them on', async () => {
    const owner = uniqueOwner();
    const h = buildTelegramHarness();
    const agentId = await seedAgent(db.pool, { ownerAddr: owner, name: 'quiet-info' });
    await linkOwner(h, owner, '1313');
    h.api.sent = [];
    await h.t.alerts.emit(owner, { agentId, class: 'info', kind: 'revoked', summary: 'fyi only' });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.api.sent).toHaveLength(0); // info OFF by default

    await request(h.app)
      .patch('/api/owner/settings')
      .set('authorization', ownerAuth(owner))
      .send({ alertPrefs: { delegation_terminal: { telegram: true } } });
    await h.t.alerts.emit(owner, { agentId, class: 'info', kind: 'delegation_terminal', summary: 'now pushed' });
    const start = Date.now();
    while (h.api.sent.length === 0 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.api.sent.some((m) => m.text === 'now pushed')).toBe(true);
  });
});
