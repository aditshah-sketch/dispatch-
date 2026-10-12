import { config } from "@/lib/server/config";

// Public, non-sensitive readiness summary (no secrets, no data).
export function GET() {
  return Response.json({
    ok: true,
    preview: true,
    liveDesk: config.database().ok && config.auth().ok,
    scheduler: config.cron().ok,
  }, { headers: { "cache-control": "no-store" } });
}
