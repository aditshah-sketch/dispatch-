import "server-only";
import { getSession, sameOrigin } from "./auth";
import { config } from "./config";
import { DatabaseUnavailableError, getDb, type Db } from "./db/client";

export function jsonError(status: number, code: string, message: string) {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

// Wraps owner-only route handlers: configuration check, session check, CSRF
// check for mutations, database access, and errors that never leak internals.
export async function ownerRoute(req: Request, fn: (db: Db) => Promise<Response>): Promise<Response> {
  if (!config.auth().ok) return jsonError(503, "NOT_CONFIGURED", "Owner sign-in isn't configured (AUTH_SECRET / OWNER_PASSWORD).");
  const session = await getSession();
  if (!session) return jsonError(401, "AUTH", "Please sign in.");
  if (req.method !== "GET" && !sameOrigin(req)) return jsonError(403, "CSRF", "Cross-site request blocked.");
  try {
    const db = await getDb();
    return await fn(db);
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) return jsonError(503, "NO_DATABASE", e.message);
    console.error("[desk]", (e as Error).name, (e as Error).message);
    return jsonError(500, "SERVER", "Something went wrong on the server. Nothing was sent; please try again.");
  }
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}
