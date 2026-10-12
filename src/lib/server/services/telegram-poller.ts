import "server-only";
import { config } from "../config";
import { getDb } from "../db/client";
import { handleUpdate } from "./telegram-bot";

// Local development only. Telegram can't deliver webhooks to localhost, so
// when the app isn't on a public HTTPS URL we long-poll getUpdates and feed
// each update through the exact same handler the webhook uses (owner check,
// update de-duplication, stale-button checks). Never runs on Vercel.

type G = typeof globalThis & { __dispatchTgPoller?: boolean };

export function shouldPoll(): boolean {
  const base = config.baseUrl() ?? "";
  return config.telegram().ok && !config.isVercel() && !base.startsWith("https://") && config.database().ok;
}

export function startTelegramPoller() {
  const g = globalThis as G;
  if (g.__dispatchTgPoller || !shouldPoll()) return;
  g.__dispatchTgPoller = true;
  const token = config.telegram().value!.token;
  let offset = 0;

  const loop = async () => {
    for (;;) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
          signal: AbortSignal.timeout(35_000),
        });
        const data = (await res.json()) as { ok: boolean; result?: Array<{ update_id: number }>; description?: string };
        if (!data.ok) {
          // 409 = a webhook is registered; webhook mode takes over.
          console.warn("[telegram-poller] stopped:", data.description);
          g.__dispatchTgPoller = false;
          return;
        }
        for (const u of data.result ?? []) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(await getDb(), u as never).catch((e) => console.error("[telegram-poller]", (e as Error).message));
        }
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
  console.log("[telegram-poller] polling Telegram for updates (local development mode)");
}
