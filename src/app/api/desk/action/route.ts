import type { ActionName } from "@/lib/client/actions";
import { jsonError, ownerRoute } from "@/lib/server/http";
import { dispatchAction } from "@/lib/server/services/actions";

export const maxDuration = 300;

export async function POST(req: Request) {
  return ownerRoute(req, async (db) => {
    const body = (await req.json().catch(() => null)) as { action?: string; input?: unknown } | null;
    if (!body?.action || typeof body.action !== "string") return jsonError(400, "INVALID", "Missing action.");
    const result = await dispatchAction(db, body.action as ActionName, body.input);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
