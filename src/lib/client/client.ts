import type { Mode } from "../domain/types";
import type {
  AlternativesView,
  ArchiveView,
  ArticlesView,
  AudienceView,
  EmailPreviewView,
  JobView,
  SettingsView,
  WeekView,
} from "../views";
import type { ActionMap, ActionName, ActionResult } from "./actions";

export interface DispatchClient {
  readonly mode: Mode;
  week(): Promise<WeekView>;
  articles(): Promise<ArticlesView>;
  archive(): Promise<ArchiveView>;
  audience(): Promise<AudienceView>;
  settings(): Promise<SettingsView>;
  alternatives(storyId: string): Promise<AlternativesView>;
  emailPreview(): Promise<EmailPreviewView>;
  job(id: string): Promise<JobView | null>;
  run<K extends ActionName>(name: K, input: ActionMap[K]["input"]): Promise<ActionResult<ActionMap[K]["output"]>>;
}

export class ViewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Live mode: thin JSON client over the owner-only API. Every rule is enforced
// again on the server; nothing here is trusted.
export class LiveClient implements DispatchClient {
  readonly mode = "live" as const;

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(path, { cache: "no-store", headers: { accept: "application/json" } });
    if (res.status === 401) {
      // A full navigation is intended: it drops client state tied to the expired session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      throw new ViewError("Signed out", 401);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ViewError(body?.error?.message ?? `Request failed (${res.status})`, res.status);
    return body as T;
  }

  week() { return this.get<WeekView>("/api/desk/view/week"); }
  articles() { return this.get<ArticlesView>("/api/desk/view/articles"); }
  archive() { return this.get<ArchiveView>("/api/desk/view/archive"); }
  audience() { return this.get<AudienceView>("/api/desk/view/audience"); }
  settings() { return this.get<SettingsView>("/api/desk/view/settings"); }
  alternatives(storyId: string) { return this.get<AlternativesView>(`/api/desk/view/alternatives?storyId=${encodeURIComponent(storyId)}`); }
  emailPreview() { return this.get<EmailPreviewView>("/api/desk/view/email"); }
  job(id: string) { return this.get<JobView | null>(`/api/desk/view/job?id=${encodeURIComponent(id)}`); }

  async run<K extends ActionName>(name: K, input: ActionMap[K]["input"]): Promise<ActionResult<ActionMap[K]["output"]>> {
    try {
      const res = await fetch("/api/desk/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: name, input }),
      });
      if (res.status === 401) {
        return { ok: false, error: { code: "AUTH", message: "Your session expired. Sign in again — your unsaved text is kept in this tab." } };
      }
      const body = await res.json().catch(() => null);
      if (!body) return { ok: false, error: { code: "NETWORK", message: `The server returned an unexpected response (${res.status}).` } };
      return body as ActionResult<ActionMap[K]["output"]>;
    } catch {
      return { ok: false, error: { code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." } };
    }
  }
}
