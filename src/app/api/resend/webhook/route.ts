import { config } from "@/lib/server/config";
import { getDb } from "@/lib/server/db/client";
import { verifyResendWebhook } from "@/lib/server/providers/resend";
import { markHealth } from "@/lib/server/repo/ops";
import { processResendEvent, type ResendEvent } from "@/lib/server/services/resend-events";

// Resend delivery webhooks (bounces, complaints, delays, deliveries).
// Authenticity: Svix signature over the raw body with RESEND_WEBHOOK_SECRET,
// plus a 5-minute timestamp window against replays.
export async function POST(req: Request) {
  const r = config.resend();
  const secret = r.value?.webhookSecret;
  if (!r.ok || !secret) return new Response("not configured", { status: 503 });
  const raw = await req.text();
  if (raw.length > 1_000_000 || !verifyResendWebhook(secret, req.headers, raw)) return new Response("invalid signature", { status: 401 });
  let ev: ResendEvent;
  try {
    ev = JSON.parse(raw) as ResendEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const id = req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? "";
  try {
    const db = await getDb();
    const outcome = await processResendEvent(db, id, ev);
    await markHealth(db, "resend_events", true);
    return Response.json({ ok: true, outcome });
  } catch (e) {
    console.error("[resend-webhook]", (e as Error).message);
    return new Response("error", { status: 500 }); // Resend retries on non-2xx
  }
}
