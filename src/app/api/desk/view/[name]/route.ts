import { jsonError, ownerRoute } from "@/lib/server/http";
import { getJob, jobView } from "@/lib/server/repo/ops";
import {
  alternativesView,
  archiveView,
  articlesView,
  audienceView,
  emailPreviewView,
  settingsView,
  weekView,
} from "@/lib/server/services/views";

export async function GET(req: Request, ctx: RouteContext<"/api/desk/view/[name]">) {
  const { name } = await ctx.params;
  const url = new URL(req.url);
  return ownerRoute(req, async (db) => {
    const send = (data: unknown) => Response.json(data, { headers: { "cache-control": "no-store" } });
    switch (name) {
      case "week": return send(await weekView(db));
      case "articles": return send(await articlesView(db));
      case "archive": return send(await archiveView(db));
      case "audience": return send(await audienceView(db));
      case "settings": return send(await settingsView(db));
      case "email": return send(await emailPreviewView(db));
      case "alternatives": return send(await alternativesView(db, url.searchParams.get("storyId") ?? ""));
      case "job": return send(jobView(await getJob(db, url.searchParams.get("id") ?? "")));
    }
    return jsonError(404, "NOT_FOUND", "Unknown view.");
  });
}
