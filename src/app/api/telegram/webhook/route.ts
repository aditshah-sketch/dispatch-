import { config } from "@/lib/server/config";
import { safeEqual } from "@/lib/server/crypto";
import { getDb } from "@/lib/server/db/client";
import { handleUpdate } from "@/lib/server/services/telegram-bot";

export const maxDuration = 60;

// Telegram webhook. Authenticity: the secret_token set at registration is
// echoed in X-Telegram-Bot-Api-Secret-Token. Owner/chat restriction, update
// de-duplication and stale-button checks happen in handleUpdate.
export async function POST(req: Request) {
  const t = config.telegram();
  if (!t.ok) return new Response("not configured", { status: 503 });
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(secret, t.value!.webhookSecret)) return new Response("forbidden", { status: 401 });
  const update = await req.json().catch(() => null);
  if (!update || typeof update.update_id !== "number") return new Response("ok");
  try {
    await handleUpdate(await getDb(), update);
  } catch (e) {
    // Acknowledge anyway: Telegram would otherwise redeliver indefinitely.
    // Errors are logged without message content.
    console.error("[telegram]", (e as Error).name, (e as Error).message);
  }
  return new Response("ok");
}
