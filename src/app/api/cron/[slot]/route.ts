import { after } from "next/server";
import { config } from "@/lib/server/config";
import { safeEqual } from "@/lib/server/crypto";
import { DatabaseUnavailableError, getDb } from "@/lib/server/db/client";
import { jsonError } from "@/lib/server/http";
import { tick } from "@/lib/server/services/scheduler";

// Authenticated scheduler entry point. Called by Vercel Cron (GET with
// "Authorization: Bearer $CRON_SECRET"), by an external scheduler, or by
// itself to continue a long send in bounded, resumable batches. The [slot]
// segment only labels the caller (collect, draft, reminder, send, tick...);
// every slot runs the same idempotent tick.
export const maxDuration = 300;

async function handle(req: Request) {
  const cron = config.cron();
  if (!cron.ok) return jsonError(503, "NOT_CONFIGURED", "CRON_SECRET is not set; scheduled work is disabled.");
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${cron.value!.secret}`)) return jsonError(401, "AUTH", "Unauthorized.");
  try {
    const db = await getDb();
    const result = await tick(db, { budgetMs: 270_000 });
    const hop = Number(new URL(req.url).searchParams.get("hop") ?? 0);
    const base = config.baseUrl();
    // Continue a long-running send without waiting for the next cron slot.
    if (result.more && base && hop < 20) {
      after(() => fetch(`${base}/api/cron/continue?hop=${hop + 1}`, { method: "POST", headers: { authorization: auth } }).then(() => undefined).catch(() => undefined));
    }
    return Response.json({ ok: true, created: result.created, ran: result.ran.map((r) => ({ kind: r.kind, detail: r.detail.slice(0, 200) })), more: result.more });
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) return jsonError(503, "NO_DATABASE", e.message);
    console.error("[cron]", (e as Error).message);
    return jsonError(500, "SERVER", "Tick failed; jobs remain queued and will be retried.");
  }
}

export const GET = handle;
export const POST = handle;
