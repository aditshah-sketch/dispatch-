import "server-only";
import { apiFetch } from "../net/safe-fetch";

// Telegram Bot API adapter (core.telegram.org/bots/api). Limits respected:
// message text ≤ 4096 chars, callback_data ≤ 64 bytes, ~1 msg/sec per chat.

export const TELEGRAM_MAX_TEXT = 4096;

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TelegramClient {
  constructor(private token: string) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await apiFetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 15_000,
      });
    } catch (e) {
      throw new TelegramError(`Couldn't reach Telegram: ${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`, 0);
    }
    const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | null;
    if (!data?.ok) {
      throw new TelegramError(data?.description ?? `Telegram error ${res.status}`, res.status, data?.parameters?.retry_after);
    }
    return data.result as T;
  }

  getMe() {
    return this.call<{ id: number; username: string }>("getMe", {});
  }

  setWebhook(url: string, secret: string) {
    return this.call<boolean>("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  }

  getWebhookInfo() {
    return this.call<{ url: string; last_error_message?: string; pending_update_count: number }>("getWebhookInfo", {});
  }

  async sendMessage(chatId: string, text: string, opts: { buttons?: InlineButton[][]; forceReply?: boolean; placeholder?: string; replyTo?: number } = {}) {
    const reply_markup = opts.forceReply
      ? { force_reply: true, input_field_placeholder: opts.placeholder?.slice(0, 64), selective: true }
      : opts.buttons
        ? { inline_keyboard: opts.buttons }
        : undefined;
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, TELEGRAM_MAX_TEXT),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup,
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  answerCallback(id: string, text?: string, alert = false) {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: id, text: text?.slice(0, 190), show_alert: alert });
  }

  clearButtons(chatId: string, messageId: number) {
    return this.call<unknown>("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
}

// Splits long text on paragraph boundaries to respect the 4096-char limit.
export function paginate(text: string, limit = 3800): string[] {
  const pages: string[] = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    if ((current + "\n\n" + para).length > limit && current) {
      pages.push(current);
      current = para;
    } else current = current ? `${current}\n\n${para}` : para;
  }
  if (current) pages.push(current);
  return pages.map((p) => p.slice(0, TELEGRAM_MAX_TEXT));
}
