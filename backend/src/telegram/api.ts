/**
 * Telegram Bot API transport (S9). The interface is what the bot logic uses —
 * tests mock THIS boundary (transport mocked, OUR logic real, spec §8); the
 * deployed drill is the real-transport evidence. The fetch implementation
 * handles rate limits (429 retry_after) with bounded retry and never throws
 * into callers beyond its promise.
 */

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageInput {
  chat_id: string;
  text: string;
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] } | undefined;
}

export interface EditMessageInput {
  chat_id: string;
  message_id: number;
  text: string;
  /** Omitted reply_markup removes the keyboard (stale cards can't act). */
}

export interface TelegramApi {
  sendMessage(input: SendMessageInput): Promise<{ message_id: number }>;
  editMessageText(input: EditMessageInput): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
}

export interface FetchTelegramApiOptions {
  botToken: string;
  fetchFn?: typeof fetch;
  maxRetries?: number;
}

export class FetchTelegramApi implements TelegramApi {
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;

  constructor(private readonly opts: FetchTelegramApiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.opts.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const parsed = (await res.json().catch(() => null)) as {
          ok?: boolean;
          result?: T;
          description?: string;
          parameters?: { retry_after?: number };
        } | null;
        if (parsed?.ok) return parsed.result as T;
        // 429: honor retry_after (bounded); other errors are terminal.
        const retryAfter = parsed?.parameters?.retry_after;
        if (res.status === 429 && retryAfter !== undefined && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
          continue;
        }
        throw new Error(`telegram ${method} failed: ${res.status} ${parsed?.description ?? 'unknown'}`);
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async sendMessage(input: SendMessageInput): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('sendMessage', { ...input });
  }

  async editMessageText(input: EditMessageInput): Promise<void> {
    await this.call('editMessageText', { ...input });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text !== undefined ? { text } : {}),
    });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: secretToken });
  }
}
