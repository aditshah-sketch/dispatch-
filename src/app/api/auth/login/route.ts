import { NextResponse } from "next/server";
import { checkPassword, createSessionToken, SESSION_COOKIE, sessionCookieOptions, sameOrigin } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { getDb } from "@/lib/server/db/client";
import { clientIp } from "@/lib/server/http";
import { audit, rateLimit } from "@/lib/server/repo/ops";

// Fallback limiter if the database is unavailable (per-instance only).
const memory = new Map<string, { n: number; reset: number }>();

async function allowed(ip: string): Promise<boolean> {
  try {
    const db = await getDb();
    return await rateLimit(db, `login:${ip}`, 8, 900);
  } catch {
    const now = Date.now();
    const e = memory.get(ip);
    if (!e || e.reset < now) {
      memory.set(ip, { n: 1, reset: now + 900_000 });
      return true;
    }
    e.n++;
    return e.n <= 8;
  }
}

function safeNext(raw: FormDataEntryValue | null): string {
  const n = typeof raw === "string" ? raw : "";
  return n.startsWith("/desk") && !n.startsWith("//") ? n : "/desk";
}

export async function POST(req: Request) {
  const form = await req.formData();
  const next = safeNext(form.get("next"));
  const back = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}&next=${encodeURIComponent(next)}`, req.url), 303);
  if (!sameOrigin(req)) return back("csrf");
  if (!config.auth().ok) return back("config");
  if (!(await allowed(clientIp(req)))) return back("rate");
  if (!checkPassword(String(form.get("password") ?? ""))) {
    await getDb().then((db) => audit(db, { actor: "anonymous", action: "auth.failed", message: "Failed owner sign-in attempt." })).catch(() => undefined);
    return back("invalid");
  }
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken(), sessionCookieOptions);
  return res;
}
