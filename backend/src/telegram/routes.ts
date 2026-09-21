import { timingSafeEqual } from 'node:crypto';
import { Router, json, type Request, type Response } from 'express';
import type { TelegramBot } from './bot.js';

/**
 * The PUBLIC webhook surface (S9): POST /api/telegram/webhook, authenticated
 * ONLY by Telegram's X-Telegram-Bot-Api-Secret-Token header (constant-time
 * compare) — NO Privy on this route; every other owner route is untouched.
 * Mounted BEFORE the owner router so the owner-wide Privy middleware never
 * sees this path. Always answers 200 to valid-secret requests (Telegram
 * retries non-200s; our handling is idempotent but 200-fast is politer).
 */
export function telegramWebhookRouter(bot: TelegramBot, webhookSecret: string): Router {
  const router = Router();
  router.use('/api/telegram/webhook', json({ limit: 64 * 1024 }));
  router.post('/api/telegram/webhook', (req: Request, res: Response) => {
    const given = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof given !== 'string' || !constantTimeEqual(given, webhookSecret)) {
      res.status(401).json({ error: { message: 'unauthorized' } });
      return;
    }
    // Fire-and-forget: Telegram wants a fast 200; our handling is async and
    // failure-logged (a lost update is re-delivered by Telegram anyway).
    void bot.handleUpdate(req.body).catch((err: unknown) => console.error('telegram update failed', err));
    res.json({ ok: true });
  });
  return router;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
