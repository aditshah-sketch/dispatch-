import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db/client";
import { clientIp } from "@/lib/server/http";
import { audit, rateLimit } from "@/lib/server/repo/ops";
import { resolveUnsubscribeToken } from "@/lib/server/services/unsubscribe";

// Handles both RFC 8058 one-click POSTs from mail clients
// (body "List-Unsubscribe=One-Click") and the confirmation form on /u/[token].
// GET never unsubscribes, so link scanners can't remove people by accident.
export async function POST(req: Request, ctx: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  const db = await getDb();
  if (!(await rateLimit(db, `unsub:${clientIp(req)}`, 30, 3600))) return new Response("Too many requests", { status: 429 });
  const sub = await resolveUnsubscribeToken(db, token);
  const form = await req.formData().catch(() => null);
  const oneClick = form?.get("List-Unsubscribe") === "One-Click";
  if (!sub) return oneClick ? new Response("Invalid link", { status: 400 }) : NextResponse.redirect(new URL(`/u/${encodeURIComponent(token)}`, req.url), 303);
  // Idempotent: unsubscribing twice is fine; a bounce status is preserved.
  const rows = await db.query(`update subscribers set status = 'UNSUBSCRIBED', status_reason = $2, updated_at = now() where id = $1 and status = 'ACTIVE' returning id`, [sub.id, oneClick ? "One-click unsubscribe from email client" : "Unsubscribed via link"]);
  if (rows.length) await audit(db, { actor: "subscriber", action: "subscriber.unsubscribed", entityType: "subscriber", entityId: sub.id, message: "A subscriber unsubscribed." });
  return oneClick ? new Response("Unsubscribed", { status: 200 }) : NextResponse.redirect(new URL(`/u/${encodeURIComponent(token)}?done=1`, req.url), 303);
}
