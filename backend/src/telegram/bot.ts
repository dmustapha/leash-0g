import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { TelegramApi } from './api.js';
import type { Alert } from '../types.js';
import type { TelegramDelivery } from '../alerts/service.js';
import { getAgentById } from '../store/agents.js';
import { getApproval } from '../store/approvals.js';
import { decideApprovalWithConsent, type DecideDeps } from '../approvals/decide.js';
import { setTelegramMessageId } from '../alerts/store.js';
import {
  getOwnerSettings,
  getOwnerByChatId,
  setTelegramChat,
  clearTelegramChat,
} from '../store/owner-settings.js';

/**
 * The LEASH Telegram bot (spec §3b, S9): delivery + inline approve/deny ONLY.
 * Minimal-disclosure pushes (00 §6b — never reasoning/payloads), callbacks
 * ride THE shared consent rails (approvals/decide.ts) after resolving a
 * server-side single-use token and verifying the linked chat. No spend /
 * policy / create / revoke capability exists on this surface (deliberate
 * containment, spec §6) — the bot token is a delivery credential, never an
 * authority key.
 */

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Telegram update shapes — strictly validated at the webhook (spec §6). */
const updateSchema = z
  .object({
    message: z
      .object({
        chat: z.object({ id: z.union([z.number(), z.string()]) }),
        text: z.string().optional(),
      })
      .optional(),
    callback_query: z
      .object({
        id: z.string(),
        data: z.string().max(128).optional(),
        message: z
          .object({
            chat: z.object({ id: z.union([z.number(), z.string()]) }),
            message_id: z.number(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export interface TelegramBotDeps {
  pool: Pool;
  api: TelegramApi;
  botUsername: string;
  /** Consent-rail deps — identical to POST /api/approvals/:id (spec §3b). */
  decide: DecideDeps;
  /** Late-bound digest provider (task-order: the digest service lands after the bot). */
  digestProvider?: (ownerAddr: string) => Promise<string>;
}

export class TelegramBot {
  private digestProvider: ((ownerAddr: string) => Promise<string>) | null;

  constructor(private readonly deps: TelegramBotDeps) {
    this.digestProvider = deps.digestProvider ?? null;
  }

  setDigestProvider(fn: (ownerAddr: string) => Promise<string>): void {
    this.digestProvider = fn;
  }

  // ------------------------------------------------------------------
  // Linking (spec §3b): one-time deep-link token, 5-min TTL, hash-at-rest.
  // ------------------------------------------------------------------

  async issueLinkToken(ownerAddr: string): Promise<{ url: string; expiresAt: string }> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.deps.pool.query(
      `INSERT INTO telegram_link_tokens (token_hash, owner_addr, expires_at) VALUES ($1,$2,$3)`,
      [sha256(token), ownerAddr.toLowerCase(), expiresAt.toISOString()],
    );
    return { url: `https://t.me/${this.deps.botUsername}?start=${token}`, expiresAt: expiresAt.toISOString() };
  }

  async unlink(ownerAddr: string): Promise<void> {
    const settings = await getOwnerSettings(this.deps.pool, ownerAddr);
    await clearTelegramChat(this.deps.pool, ownerAddr);
    if (settings.telegramChatId) {
      await this.safeSend(settings.telegramChatId, 'This chat has been unlinked from LEASH. Alerts stop here.');
    }
  }

  /** Public send used by the digest scheduler (rate-limit handling + logging inside). */
  async sendTo(chatId: string, text: string): Promise<void> {
    await this.safeSend(chatId, text);
  }

  /** Test ping from the FE settings surface. */
  async ping(ownerAddr: string): Promise<boolean> {
    const settings = await getOwnerSettings(this.deps.pool, ownerAddr);
    if (!settings.telegramChatId) return false;
    await this.deps.api.sendMessage({
      chat_id: settings.telegramChatId,
      text: 'LEASH test ping — this chat receives your agent alerts.',
    });
    return true;
  }

  // ------------------------------------------------------------------
  // Webhook update handling (strictly validated; called by the router
  // AFTER the secret-token check).
  // ------------------------------------------------------------------

  async handleUpdate(raw: unknown): Promise<void> {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) return; // strict validation: garbage is dropped
    const update = parsed.data;
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    if (text.startsWith('/start')) {
      await this.handleStart(chatId, text.slice('/start'.length).trim());
    } else if (text === '/status') {
      await this.handleStatus(chatId);
    } else if (text === '/agents') {
      await this.handleAgents(chatId);
    } else if (text === '/pending') {
      await this.handlePending(chatId);
    } else if (text === '/digest') {
      await this.handleDigest(chatId);
    } else if (text === '/unlink') {
      const owner = await getOwnerByChatId(this.deps.pool, chatId);
      if (owner) await this.unlink(owner);
    }
    // Anything else: silently ignored (no capability surface).
  }

  private async handleStart(chatId: string, token: string): Promise<void> {
    if (!token) {
      await this.safeSend(chatId, 'Link this chat from the LEASH app: Settings → Alerts → Link Telegram.');
      return;
    }
    // Single-use consume: the UPDATE claims the row atomically (used_at guard).
    const res = await this.deps.pool.query<{ owner_addr: string }>(
      `UPDATE telegram_link_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING owner_addr`,
      [sha256(token)],
    );
    const owner = res.rows[0]?.owner_addr;
    if (!owner) {
      await this.safeSend(chatId, 'That link is expired or already used — generate a fresh one in the LEASH app.');
      return;
    }
    // Re-link replaces; the OLD chat is told (spec §6 link-flow control).
    const previous = await getOwnerSettings(this.deps.pool, owner);
    if (previous.telegramChatId && previous.telegramChatId !== chatId) {
      await this.safeSend(
        previous.telegramChatId,
        'LEASH alerts were just linked to a different Telegram chat. If this was not you, unlink in the app now.',
      );
    }
    await setTelegramChat(this.deps.pool, owner, chatId);
    await this.safeSend(
      chatId,
      'Linked. You will get boundary alerts here — approve or deny straight from the message.\n' +
        'You can also ask me anytime:\n' +
        '/status — fleet snapshot\n' +
        '/agents — each agent, its state and open decisions\n' +
        '/pending — re-send any decisions still waiting on you\n' +
        '/digest — activity since you last looked\n' +
        '/unlink — stop alerts here',
    );
  }

  private async handleStatus(chatId: string): Promise<void> {
    const owner = await getOwnerByChatId(this.deps.pool, chatId);
    if (!owner) {
      await this.safeSend(chatId, 'This chat is not linked to LEASH.');
      return;
    }
    const res = await this.deps.pool.query<{ n: string; active: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE status = 'active') AS active FROM agents WHERE owner_addr = $1`,
      [owner],
    );
    const open = await this.deps.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM alerts WHERE owner_addr = $1 AND status IN ('unread','read') AND class = 'decision'`,
      [owner],
    );
    const row = res.rows[0];
    await this.safeSend(
      chatId,
      `Fleet: ${row?.active ?? 0} active of ${row?.n ?? 0} agent(s) · ${open.rows[0]?.n ?? 0} open decision(s).`,
    );
  }

  /** Two-way query: per-agent state + open decisions (read-only, minimal disclosure). */
  private async handleAgents(chatId: string): Promise<void> {
    const owner = await getOwnerByChatId(this.deps.pool, chatId);
    if (!owner) {
      await this.safeSend(chatId, 'This chat is not linked to LEASH.');
      return;
    }
    const rows = await this.deps.pool.query<{ id: string; name: string; status: string; open: string }>(
      `SELECT a.id, a.name, a.status,
              (SELECT count(*) FROM alerts al
                WHERE al.agent_id = a.id AND al.class = 'decision' AND al.status IN ('unread','read')) AS open
       FROM agents a WHERE a.owner_addr = $1 ORDER BY a.created_at ASC`,
      [owner],
    );
    if (rows.rows.length === 0) {
      await this.safeSend(chatId, 'No agents yet — create one in the LEASH app.');
      return;
    }
    const lines = rows.rows.map((r) => {
      const open = Number(r.open);
      const state = r.status === 'revoked' ? 'revoked' : 'active';
      return `🐕 ${r.name} — ${state}${open > 0 ? ` · ${open} decision${open === 1 ? '' : 's'} waiting on you (send /pending)` : ''}`;
    });
    await this.safeSend(chatId, lines.join('\n'));
  }

  /** Two-way query: re-send fresh decision cards for anything still open. */
  private async handlePending(chatId: string): Promise<void> {
    const owner = await getOwnerByChatId(this.deps.pool, chatId);
    if (!owner) {
      await this.safeSend(chatId, 'This chat is not linked to LEASH.');
      return;
    }
    const open = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM alerts
       WHERE owner_addr = $1 AND class = 'decision' AND kind = 'approval_required'
         AND status IN ('unread','read')
       ORDER BY created_at ASC LIMIT 5`,
      [owner],
    );
    if (open.rows.length === 0) {
      await this.safeSend(chatId, 'Nothing waiting on you — your agents are running inside their leash.');
      return;
    }
    // Re-push each card through the normal delivery path: fresh single-use
    // buttons, same consent rails, edit-on-resolve still applies.
    const { getAlert } = await import('../alerts/store.js');
    for (const row of open.rows) {
      const alert = await getAlert(this.deps.pool, row.id);
      if (alert) await this.pushAlert(owner, alert);
    }
  }

  private async handleDigest(chatId: string): Promise<void> {
    const owner = await getOwnerByChatId(this.deps.pool, chatId);
    if (!owner) {
      await this.safeSend(chatId, 'This chat is not linked to LEASH.');
      return;
    }
    if (!this.digestProvider) {
      await this.safeSend(chatId, 'Digest is not available right now — try the app.');
      return;
    }
    const text = await this.digestProvider(owner);
    await this.safeSend(chatId, text);
  }

  // ------------------------------------------------------------------
  // Inline decide — THE consent rail (spec §3b).
  // ------------------------------------------------------------------

  private async handleCallback(cb: {
    id: string;
    data?: string | undefined;
    message?: { chat: { id: number | string }; message_id: number } | undefined;
  }): Promise<void> {
    const answer = (text: string): Promise<void> =>
      this.deps.api.answerCallbackQuery(cb.id, text).catch(() => undefined);
    const data = cb.data ?? '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(data)) {
      await answer('Invalid action.');
      return;
    }
    // M-02 (security gate): AUTHORIZE first, CLAIM last — an unauthorized
    // tap (wrong chat after a re-link race) must not burn the token and kill
    // the legitimate chat's decision path. The atomic used_at UPDATE stays
    // the final race-free gate against replay/double-tap.
    const found = await this.deps.pool.query<{
      owner_addr: string;
      approval_id: string;
      alert_id: string;
      decision: 'approve' | 'deny';
    }>(
      `SELECT owner_addr, approval_id, alert_id, decision FROM telegram_callbacks
       WHERE token_hash = $1 AND used_at IS NULL`,
      [sha256(data)],
    );
    const row = found.rows[0];
    if (!row) {
      await answer('This action is no longer valid.');
      return;
    }
    // The tapping chat MUST be the linked chat of the approval's owner —
    // a forwarded card in a stranger's chat cannot decide (spec §6).
    const chatId = cb.message ? String(cb.message.chat.id) : null;
    const settings = await getOwnerSettings(this.deps.pool, row.owner_addr);
    if (!chatId || !settings.telegramChatId || settings.telegramChatId !== chatId) {
      await answer('This chat is not authorized to decide.');
      return;
    }
    const approval = await getApproval(this.deps.pool, row.approval_id);
    if (!approval) {
      await answer('Approval not found.');
      return;
    }
    const agent = await getAgentById(this.deps.pool, approval.agentId);
    if (!agent || agent.ownerAddr !== row.owner_addr) {
      await answer('Not authorized.');
      return;
    }
    if (approval.state !== 'pending') {
      await answer('Already decided.');
      return;
    }
    // Race-free single-use claim (replay/double-tap loses HERE).
    const claimed = await this.deps.pool.query(
      `UPDATE telegram_callbacks SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL`,
      [sha256(data)],
    );
    if (claimed.rowCount === 0) {
      await answer('This action is no longer valid.');
      return;
    }
    const outcome = await decideApprovalWithConsent(this.deps.decide, agent, approval, row.decision, {
      channel: 'telegram',
      reason: undefined,
    });
    if (!outcome.ok) {
      await answer('Already decided.');
      return;
    }
    await answer(row.decision === 'approve' ? 'Approved.' : 'Denied.');
    // The message edit rides the alert resolution (resolveAlert below) —
    // decideApprovalWithConsent triggers alerts.resolveByApproval, whose
    // Telegram edge edits this card. Nothing further to do here.
  }

  // ------------------------------------------------------------------
  // Alert delivery edge (registered with AlertService).
  // ------------------------------------------------------------------

  delivery(): TelegramDelivery {
    return {
      pushAlert: (ownerAddr, alert) => this.pushAlert(ownerAddr, alert),
      resolveAlert: (ownerAddr, alert) => this.resolveAlert(ownerAddr, alert),
    };
  }

  /** S11 defaults at link: decision-class ON, info-class OFF; explicit prefs override. */
  private telegramEnabled(alert: Alert, prefs: Record<string, { telegram?: boolean | undefined }>): boolean {
    const explicit = prefs[alert.kind]?.telegram;
    if (explicit !== undefined) return explicit;
    return alert.class === 'decision';
  }

  private async pushAlert(ownerAddr: string, alert: Alert): Promise<void> {
    const settings = await getOwnerSettings(this.deps.pool, ownerAddr);
    if (!settings.telegramChatId) return;
    if (!this.telegramEnabled(alert, settings.alertPrefs)) return;

    // Minimal disclosure (00 §6b): the alert summary is edge-composed plain
    // language (agent name, kind, amount/address where relevant) — never
    // reasoning content, trace payloads, or delegation payloads.
    let replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
    if (alert.kind === 'approval_required' && typeof alert.refs.approvalId === 'string') {
      const approve = randomBytes(24).toString('base64url');
      const deny = randomBytes(24).toString('base64url');
      await this.deps.pool.query(
        `INSERT INTO telegram_callbacks (token_hash, owner_addr, approval_id, alert_id, decision)
         VALUES ($1,$2,$3,$4,'approve'), ($5,$2,$3,$4,'deny')`,
        [sha256(approve), ownerAddr.toLowerCase(), alert.refs.approvalId, alert.id, sha256(deny)],
      );
      replyMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: approve },
            { text: '❌ Deny', callback_data: deny },
          ],
        ],
      };
    }
    // Agent's stated purpose (00 §6b): server-sanitized, carried in refs, shown
    // as a clearly-labeled UNVERIFIED line, quarantined below the verified facts.
    const intent = typeof alert.refs.agentIntent === 'string' ? alert.refs.agentIntent : '';
    const text = intent ? `${alert.summary}\n\n🤖 Agent says (unverified): "${intent}"` : alert.summary;
    const sent = await this.deps.api.sendMessage({
      chat_id: settings.telegramChatId,
      text,
      reply_markup: replyMarkup,
    });
    await setTelegramMessageId(this.deps.pool, alert.id, String(sent.message_id));
  }

  /** Edit-on-resolve (spec §3b): decided anywhere or expired ⇒ the card shows the outcome, buttons gone. */
  private async resolveAlert(ownerAddr: string, alert: Alert): Promise<void> {
    if (alert.telegramMessageId === undefined) return;
    const settings = await getOwnerSettings(this.deps.pool, ownerAddr);
    if (!settings.telegramChatId) return;
    const outcome =
      alert.resolution === 'approve'
        ? '✅ Approved'
        : alert.resolution === 'deny'
          ? '❌ Denied'
          : alert.resolution === 'expired'
            ? '⌛ Expired (denied by default)'
            : '✔️ Dismissed';
    const via = alert.resolvedVia === 'telegram' ? ' via Telegram' : alert.resolvedVia === 'app' ? ' in the app' : '';
    await this.deps.api.editMessageText({
      chat_id: settings.telegramChatId,
      message_id: Number(alert.telegramMessageId),
      text: `${alert.summary}\n\n${outcome}${via}.`,
    });
  }

  /** Send that logs instead of throwing — Telegram down never blocks anything. */
  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.deps.api.sendMessage({ chat_id: chatId, text });
    } catch (err) {
      console.error('telegram send failed', err);
    }
  }
}
