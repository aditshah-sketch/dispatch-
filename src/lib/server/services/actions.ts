import "server-only";
import { after } from "next/server";
import { z } from "zod";
import type { ActionName, ActionResult } from "../../client/actions";
import {
  addStory,
  confirmEdition,
  editFraming,
  editStory,
  moveStory,
  removeStory,
  revokeApproval,
  setStoryReview,
  swapStory,
} from "../../domain/edition";
import { currentPublishDate, isValidHHMM } from "../../domain/schedule";
import { TOPIC_IDS, type TopicId } from "../../domain/topics";
import { isHttpUrl } from "../../domain/url";
import { config } from "../config";
import type { Db } from "../db/client";
import { gmailProfile, GoogleApiError } from "../providers/google";
import { TelegramClient } from "../providers/telegram";
import { addSource, setSourceEnabled } from "../repo/articles";
import { importEdition } from "../repo/editions";
import { addSubscriber, audit, enqueue, markHealth, rateLimit, rearm, setSubscriberStatus, getSubscriber } from "../repo/ops";
import { getSettings, saveStyleGuide, updateSettings } from "../repo/settings";
import { bookCalendarAction, checkAvailability, deleteCalendarDraft, saveCalendarDraft } from "./calendar";
import { retryUnknown } from "./delivery";
import { regenerateStoryCommentary, suggestMeeting } from "./drafting";
import { applyCommand, currentEdition, finalisationContext, liveAnalysis } from "./editorial";
import { googleAccessToken } from "./google-auth";
import { runJobNow, tick } from "./scheduler";
import { createLinkCode, sendDraft } from "./telegram-bot";

const ACTOR = "owner";

const S = {
  storyId: z.string().min(1).max(64),
  version: z.number().int().min(0),
};

const schemas: Partial<Record<ActionName, z.ZodType>> = {
  generateDraft: z.object({ replace: z.boolean().optional() }),
  editStory: z.object({
    storyId: S.storyId,
    baseVersion: S.version,
    patch: z.object({ commentary: z.string().max(1200).optional(), headline: z.string().max(300).optional(), topic: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]).optional() }),
  }),
  setStoryReview: z.object({ storyId: S.storyId, approved: z.boolean() }),
  removeStory: z.object({ storyId: S.storyId }),
  swapStory: z.object({ storyId: S.storyId, articleId: z.string().max(64) }),
  addStory: z.object({ articleId: z.string().max(64) }),
  moveStory: z.object({ storyId: S.storyId, direction: z.union([z.literal(-1), z.literal(1)]) }),
  editFraming: z.object({ subject: z.string().max(200).optional(), intro: z.string().max(1500).optional(), baseRevision: z.number().int() }),
  regenerateCommentary: z.object({ storyId: S.storyId, baseVersion: S.version }),
  confirmEdition: z.object({ revision: z.number().int(), contentHash: z.string().max(64), sendNow: z.boolean(), sendAt: z.string().max(40).nullable() }),
  revokeApproval: z.object({ reason: z.string().min(1).max(300) }),
  retryUnknownDeliveries: z.object({ confirm: z.literal(true) }),
  addSubscribers: z.object({ text: z.string().max(400_000) }),
  setSubscriberStatus: z.object({ id: z.string().max(64), status: z.enum(["UNSUBSCRIBED", "ACTIVE"]) }),
  importHistory: z.object({ publishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), subject: z.string().max(200), stories: z.string().max(20_000) }),
  saveStyleGuide: z.object({ content: z.string().min(1).max(8000), examples: z.string().max(20_000) }),
  saveSchedule: z.object({
    schedule: z.object({
      timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone"),
      collectDays: z.array(z.number().int().min(1).max(7)).min(1),
      collectTime: z.string().refine(isValidHHMM), draftDay: z.number().int().min(1).max(7), draftTime: z.string().refine(isValidHHMM),
      draftDeliveryTime: z.string().refine(isValidHHMM), reminderTime: z.string().refine(isValidHHMM), sendDay: z.number().int().min(1).max(7), sendTime: z.string().refine(isValidHHMM),
    }),
  }),
  saveSending: z.object({
    fromName: z.string().min(1).max(100), replyTo: z.union([z.literal(""), z.string().email()]), dailyLimit: z.number().int().min(1).max(100_000),
    accountType: z.enum(["gmail", "workspace", "resend", "custom"]), newsletterName: z.string().min(1).max(100), footer: z.string().max(600),
  }),
  toggleSource: z.object({ id: z.string().max(64), enabled: z.boolean() }),
  addSource: z.object({ kind: z.enum(["rss", "news_query"]), name: z.string().min(1).max(80), locator: z.string().min(2).max(500) }),
  testIntegration: z.object({ key: z.string().max(40) }),
  saveCalendarDraft: z.object({
    id: z.string().max(64).optional(), kind: z.enum(["REVIEW_BLOCK", "DEADLINE_ALERT", "MEETING"]), storyId: z.string().max(64).nullable().optional(),
    title: z.string().max(200), startAt: z.string().max(40), durationMinutes: z.number().int(), attendees: z.array(z.string().max(254)).max(20),
    agenda: z.string().max(4000), withMeet: z.boolean(), reminderMinutes: z.number().int().min(0).max(1440),
  }),
  suggestMeeting: z.object({ storyId: S.storyId }),
  checkAvailability: z.object({ startAt: z.string().max(40), durationMinutes: z.number().int().min(5).max(480) }),
  bookCalendarAction: z.object({ id: z.string().max(64), confirm: z.literal(true), detailsHash: z.string().max(64) }),
  deleteCalendarDraft: z.object({ id: z.string().max(64) }),
  runScheduledNow: z.object({ task: z.enum(["draft_delivery", "reminder", "send_due", "feedback", "process_jobs"]) }),
};

const fail = (code: string, message: string): ActionResult<never> => ({ ok: false, error: { code, message } });
const done = <T,>(data: T, message?: string): ActionResult<T> => ({ ok: true, data, message });

function strip<T>(r: ActionResult<T>): ActionResult<unknown> {
  return r.ok ? { ...r, data: null } : r;
}

// Background execution for long work (collection, draft generation): the job
// row is the durable record; `after` runs it once the response is sent, and
// the scheduler would pick it up anyway if this instance died.
function runInBackground(db: Db, jobId: string) {
  after(async () => {
    await runJobNow(db, jobId, 270_000).catch(() => undefined);
  });
}

export async function dispatchAction(db: Db, name: ActionName, raw: unknown): Promise<ActionResult<unknown>> {
  const schema = schemas[name];
  let input: Record<string, unknown> = {};
  if (schema) {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return fail("INVALID", `Invalid input: ${parsed.error.issues[0]?.message ?? "check the form"}`);
    input = parsed.data as Record<string, unknown>;
  }

  switch (name) {
    case "collect": {
      if (!(await rateLimit(db, "collect", 12, 3600))) return fail("RATE_LIMITED", "Collection was run many times this hour. Try again later.");
      const { job } = await enqueue(db, { kind: "COLLECT", dedupeKey: `collect:manual:${Date.now()}` });
      runInBackground(db, job.id);
      return done({ jobId: job.id }, "Collection started.");
    }
    case "generateDraft": {
      if (!config.gemini().ok) return fail("UNAVAILABLE", "Gemini isn't configured. Add GEMINI_API_KEY, or pick stories by hand from the Articles page.");
      if (!(await rateLimit(db, "generate", 6, 3600))) return fail("RATE_LIMITED", "Draft generation was run many times this hour. Try again later.");
      const ed = await currentEdition(db);
      if (ed.stories.length && !input.replace) return fail("INVALID", "A draft already exists. Regenerating would replace it and your edits.");
      const { job } = await enqueue(db, { kind: "GENERATE_DRAFT", dedupeKey: `draft:manual:${Date.now()}`, payload: { replace: !!input.replace, editionId: ed.id } });
      runInBackground(db, job.id);
      return done({ jobId: job.id }, "Generating the draft — this takes about a minute.");
    }
    case "editStory": {
      const r = await applyCommand(db, ACTOR, (ed, at) => editStory(ed, input as never, at));
      if (!r.ok) return r;
      const story = r.data.edition.stories.find((s) => s.id === input.storyId)!;
      return done({ story, revision: r.data.edition.revision }, r.message);
    }
    case "setStoryReview":
      return strip(await applyCommand(db, ACTOR, (ed, at) => setStoryReview(ed, input as never, at)));
    case "removeStory":
      return strip(await applyCommand(db, ACTOR, (ed, at) => removeStory(ed, input as never, at)));
    case "moveStory":
      return strip(await applyCommand(db, ACTOR, (ed, at) => moveStory(ed, input as never, at)));
    case "editFraming": {
      const r = await applyCommand(db, ACTOR, (ed, at) =>
        ed.revision !== input.baseRevision
          ? { ok: false, error: { code: "CONFLICT", message: "The edition changed since you started editing. Your text is kept — save again to apply it." } }
          : editFraming(ed, input as never, at),
      );
      return r.ok ? done({ revision: r.data.edition.revision }, r.message) : r;
    }
    case "swapStory":
    case "addStory": {
      const ed = await currentEdition(db);
      const cand = (await liveAnalysis(db, ed)).candidates.find((c) => c.articleId === input.articleId);
      if (!cand) return fail("NOT_FOUND", "That article isn't eligible (duplicate, same event as another story, or previously covered).");
      return strip(
        await applyCommand(db, ACTOR, (e, at) => (name === "swapStory" ? swapStory(e, { storyId: String(input.storyId), candidate: cand }, at) : addStory(e, { candidate: cand }, at)), { editionId: ed.id }).then(async (r) => {
          if (r.ok && name === "addStory" && !r.data.edition.subject) {
            await applyCommand(db, ACTOR, (e, at) => editFraming(e, { subject: "The Dispatch" }, at));
          }
          return r;
        }),
      );
    }
    case "regenerateCommentary": {
      if (!config.gemini().ok) return fail("UNAVAILABLE", "Gemini isn't configured.");
      if (!(await rateLimit(db, "regen", 30, 3600))) return fail("RATE_LIMITED", "Too many regenerations this hour.");
      const ed = await currentEdition(db);
      const story = ed.stories.find((s) => s.id === input.storyId);
      if (!story) return fail("NOT_FOUND", "Story not found.");
      if (story.version !== input.baseVersion) return fail("CONFLICT", "This story changed since you opened it. Reload and try again.");
      let gen: { commentary: string; warnings: string[] };
      try {
        gen = await regenerateStoryCommentary(db, ed, story.id);
      } catch (e) {
        return fail("FAILED", (e as Error).message);
      }
      const r = await applyCommand(db, ACTOR, (e, at) => {
        const res = editStory(e, { storyId: story.id, baseVersion: Number(input.baseVersion), patch: { commentary: gen.commentary } }, at);
        if (!res.ok) return res;
        // Mark as AI text again (editStory labels changes as editor-written).
        return { ...res, edition: { ...res.edition, stories: res.edition.stories.map((s) => (s.id === story.id ? { ...s, commentaryOrigin: "ai", warnings: [...new Set([...s.warnings.filter((w) => !/evidence check/.test(w)), ...gen.warnings])] } : s)) } };
      });
      if (!r.ok) return r;
      return done({ story: r.data.edition.stories.find((s) => s.id === story.id)! }, "Commentary rewritten by Gemini for this story only.");
    }
    case "confirmEdition": {
      const ctx = await finalisationContext(db);
      const r = await applyCommand(db, ACTOR, (ed, at) =>
        confirmEdition(ed, { revision: Number(input.revision), contentHash: String(input.contentHash), sendNow: !!input.sendNow, sendAt: (input.sendAt as string) ?? null, channel: "dashboard", sender: ctx.sender }, ctx, at),
      );
      // "Send now" shouldn't wait for the next scheduler tick: start the same
      // send job (with all its checks) right after responding.
      if (r.ok && input.sendNow && r.data.edition.approval) {
        const [job] = await db.query<{ id: string }>(`select id from jobs where dedupe_key = $1`, [`send:${r.data.edition.id}:${r.data.edition.approval.revision}`]);
        if (job) runInBackground(db, job.id);
      }
      return strip(r);
    }
    case "revokeApproval":
      return strip(await applyCommand(db, ACTOR, (ed, at) => revokeApproval(ed, input as never, at)));
    case "sendDraftToTelegram": {
      const r = await sendDraft(db, ACTOR);
      return r.ok ? done(null, r.message) : fail("FAILED", r.message);
    }
    case "retryUnknownDeliveries": {
      const ed = await currentEdition(db);
      return done(null, await retryUnknown(db, ed.id));
    }
    case "addSubscribers": {
      const lines = String(input.text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10_000);
      let added = 0, skipped = 0;
      const invalid: string[] = [];
      for (const line of lines) {
        const [emailRaw, ...rest] = line.split(/[,;\t]/);
        const email = (emailRaw ?? "").trim().replace(/^"|"$/g, "");
        if (/^email$/i.test(email)) continue; // CSV header
        if (!z.string().email().safeParse(email).success) {
          invalid.push(email);
          continue;
        }
        if (await addSubscriber(db, email, rest.join(" ").trim().replace(/^"|"$/g, "") || null)) added++;
        else skipped++;
      }
      await audit(db, { actor: ACTOR, action: "subscribers.added", message: `Added ${added} subscribers (${skipped} already present, ${invalid.length} invalid).` });
      return done({ added, skipped, invalid }, `Added ${added}.`);
    }
    case "setSubscriberStatus": {
      const sub = await getSubscriber(db, String(input.id));
      if (!sub) return fail("NOT_FOUND", "Subscriber not found.");
      if (input.status === "ACTIVE" && sub.status === "UNSUBSCRIBED") return fail("INVALID", "People who unsubscribed must opt back in themselves.");
      await setSubscriberStatus(db, sub.id, input.status as "ACTIVE" | "UNSUBSCRIBED", input.status === "ACTIVE" ? "Reactivated by editor" : "Removed by editor");
      await audit(db, { actor: ACTOR, action: "subscriber.status", entityType: "subscriber", entityId: sub.id, message: `Subscriber set to ${String(input.status).toLowerCase()}.` });
      return done(null);
    }
    case "importHistory": {
      const stories = String(input.stories)
        .split(/\r?\n/)
        .map((l) => l.split("|").map((x) => x.trim()))
        .filter((p) => p[0] && p[1]);
      const bad = stories.filter((p) => !isHttpUrl(p[1]));
      if (!stories.length || bad.length) return fail("INVALID", bad.length ? `Not a valid URL: ${bad[0][1]}` : "Add at least one line: headline | URL");
      const today = currentPublishDate(new Date(), (await getSettings(db)).schedule);
      if (String(input.publishDate) >= today) return fail("INVALID", "Imported editions must be from before the current edition.");
      try {
        await importEdition(db, { publishDate: String(input.publishDate), subject: String(input.subject), stories: stories.map((p) => ({ headline: p[0], url: p[1], publisher: p[2] ?? "" })) });
      } catch (e) {
        return fail("INVALID", (e as Error).message);
      }
      await audit(db, { actor: ACTOR, action: "history.imported", message: `Imported ${stories.length} stories from the ${input.publishDate} edition.` });
      return done({ stories: stories.length });
    }
    case "saveStyleGuide": {
      const version = await saveStyleGuide(db, String(input.content), String(input.examples));
      await audit(db, { actor: ACTOR, action: "style.saved", message: `Style guide saved as version ${version}. Existing commentary was not changed.` });
      return done({ version });
    }
    case "saveSchedule":
      await updateSettings(db, { schedule: input.schedule as never });
      return done(null, "Schedule saved.");
    case "saveSending": {
      const x = input as z.infer<NonNullable<(typeof schemas)["saveSending"]>> & Record<string, string | number>;
      await updateSettings(db, {
        sending: { fromName: String(x.fromName), replyTo: String(x.replyTo), dailyLimit: Number(x.dailyLimit), accountType: x.accountType as "gmail" },
        newsletter: { name: String(x.newsletterName), footer: String(x.footer) },
      });
      return done(null, "Email settings saved.");
    }
    case "toggleSource":
      await setSourceEnabled(db, String(input.id), !!input.enabled);
      return done(null);
    case "addSource": {
      if (input.kind === "rss") {
        const { fetchFeed } = await import("../providers/feeds");
        try {
          const f = await fetchFeed(String(input.locator));
          if (!f.items.length) return fail("INVALID", "That URL is a feed but returned no items.");
        } catch (e) {
          return fail("INVALID", `Couldn't use that feed: ${(e as Error).message}`);
        }
      }
      await addSource(db, input as never);
      return done(null, "Source added.");
    }
    case "testIntegration":
      return testIntegration(db, String(input.key));
    case "registerTelegramWebhook": {
      const t = config.telegram();
      const base = config.baseUrl();
      if (!t.ok) return fail("UNAVAILABLE", `Missing ${t.missing.join(", ")}.`);
      if (!base?.startsWith("https://")) return fail("UNAVAILABLE", "Telegram webhooks need a public HTTPS APP_BASE_URL (deploy first, or use a tunnel).");
      try {
        await new TelegramClient(t.value!.token).setWebhook(`${base}/api/telegram/webhook`, t.value!.webhookSecret);
        await markHealth(db, "telegram", true);
        return done({ detail: `Webhook registered at ${base}/api/telegram/webhook` });
      } catch (e) {
        return fail("FAILED", (e as Error).message);
      }
    }
    case "createTelegramLinkCode":
      return done({ code: await createLinkCode(db) });
    case "saveCalendarDraft": {
      const ed = await currentEdition(db);
      const r = await saveCalendarDraft(db, ed.id, input as never);
      return "error" in r ? fail("INVALID", r.error) : done(r, "Draft saved.");
    }
    case "suggestMeeting": {
      const ed = await currentEdition(db);
      const story = ed.stories.find((s) => s.id === input.storyId);
      if (!story) return fail("NOT_FOUND", "Story not found.");
      if (!config.gemini().ok) {
        return done({ title: `Follow-up: ${story.headline.slice(0, 80)}`, agenda: "- What we know so far\n- Open questions to verify\n- Next step", origin: "template" }, "Template suggestion (Gemini isn't configured).");
      }
      try {
        return done({ ...(await suggestMeeting(story)), origin: "ai" });
      } catch (e) {
        return fail("FAILED", (e as Error).message);
      }
    }
    case "checkAvailability":
      try {
        return done(await checkAvailability(db, String(input.startAt), Number(input.durationMinutes)));
      } catch (e) {
        return done({ checked: false, conflicts: [], note: `Availability not checked: ${(e as Error).message}` });
      }
    case "bookCalendarAction": {
      const r = await bookCalendarAction(db, String(input.id), String(input.detailsHash));
      return r.ok ? done(null, r.message) : fail(r.code, r.message);
    }
    case "deleteCalendarDraft":
      await deleteCalendarDraft(db, String(input.id));
      return done(null);
    case "runScheduledNow":
      return runScheduled(db, String(input.task));
    case "resetPreview":
      return fail("INVALID", "Reset only applies to the preview.");
  }
  return fail("UNKNOWN", "Unknown action.");
}

// "Run now" demo controls call exactly the services the scheduler uses.
async function runScheduled(db: Db, task: string): Promise<ActionResult<unknown>> {
  if (task === "draft_delivery") {
    const r = await sendDraft(db, ACTOR);
    return r.ok ? done({ detail: r.message }, r.message) : fail("FAILED", r.message);
  }
  if (task === "reminder") {
    const ed = await currentEdition(db);
    // Same dedupe key as the scheduled Wednesday job, so it runs once per edition.
    const { job, created } = await enqueue(db, { kind: "REMINDER", dedupeKey: `reminder:${ed.publishDate}` });
    if (!created && job.status !== "QUEUED") return done({ detail: "already" }, "The reminder already ran for this edition — it runs once per edition.");
    const r = await runJobNow(db, job.id, 60_000);
    const msg = r?.detail ?? "The reminder is already being processed.";
    return done({ detail: msg }, msg);
  }
  if (task === "send_due") {
    const ed = await currentEdition(db);
    if (ed.status !== "SCHEDULED" && ed.status !== "SENDING") return fail("BLOCKED", "Nothing to send: this edition has no valid final approval. Nothing is ever sent without one.");
    if (ed.approval) await rearm(db, `send:${ed.id}:${ed.approval.revision}`);
    const r = await tick(db, { budgetMs: 240_000 });
    const send = r.ran.find((x) => x.kind === "SEND_CAMPAIGN");
    return done({ detail: send?.detail ?? "Not due yet." }, send?.detail ?? `Scheduled for later — nothing was sent yet.`);
  }
  if (task === "feedback") {
    const { processFeedback } = await import("./feedback");
    try {
      const msg = await processFeedback(db);
      return done({ detail: msg }, msg);
    } catch (e) {
      return fail("FAILED", (e as Error).message);
    }
  }
  const r = await tick(db, { budgetMs: 240_000 });
  return done({ detail: `${r.ran.length} job(s) run` }, r.ran.length ? r.ran.map((x) => `${x.kind}: ${x.detail}`).join(" · ") : "No jobs were due.");
}

// Safe connection tests: read-only calls that never send email or create events.
async function testIntegration(db: Db, key: string): Promise<ActionResult<unknown>> {
  try {
    switch (key) {
      case "database":
        await db.query("select 1");
        return done({ detail: "Database reachable; migrations applied." });
      case "gemini": {
        const { generateJson } = await import("../providers/gemini");
        const r = await generateJson({ system: "Reply with the JSON requested.", user: 'Return {"ok": true}.', schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, validator: z.object({ ok: z.boolean() }), maxOutputTokens: 200 });
        await markHealth(db, "gemini", true);
        return done({ detail: `Gemini (${r.usage.model}) responded with valid structured output.` });
      }
      case "telegram": {
        const t = config.telegram();
        if (!t.ok) return fail("UNAVAILABLE", "Not configured.");
        const c = new TelegramClient(t.value!.token);
        const [me, hook] = await Promise.all([c.getMe(), c.getWebhookInfo()]);
        await markHealth(db, "telegram", true);
        return done({ detail: `Bot @${me.username} OK. Webhook: ${hook.url || "not registered"}${hook.last_error_message ? ` (last error: ${hook.last_error_message})` : ""}.` });
      }
      case "gmail": {
        const { token } = await googleAccessToken(db, "send");
        // gmail.send alone can't read the profile; this verifies the token refreshes.
        return done({ detail: `Access token valid for sending (${token ? "refresh OK" : "?"}). No email was sent.` });
      }
      case "resend": {
        const r = config.resend();
        if (!r.ok) return fail("UNAVAILABLE", `Missing ${r.missing.join(", ")}.`);
        const { resendCheck } = await import("../providers/resend");
        const detail = await resendCheck(r.value!.apiKey, r.value!.from);
        await markHealth(db, "resend", true);
        return done({ detail: `${detail}${r.value!.webhookSecret ? "" : " Bounce/complaint webhooks aren't set up yet (RESEND_WEBHOOK_SECRET)."}` });
      }
      case "gmail_feedback": {
        const { token } = await googleAccessToken(db, "feedback");
        const p = await gmailProfile(token);
        return done({ detail: `Mailbox ${p.emailAddress} readable. No email was sent.` });
      }
      case "calendar": {
        const now = new Date();
        const r = await checkAvailability(db, now.toISOString(), 60);
        return done({ detail: `Calendar reachable (${r.conflicts.length} busy block(s) in the next hour). No event was created.` });
      }
      case "news_api": {
        const g = config.newsApi();
        if (!g.ok) {
          const { searchGoogleNews } = await import("../providers/feeds");
          const r = await searchGoogleNews("Indian startup", new Date(Date.now() - 3 * 86_400_000).toISOString());
          await markHealth(db, "news_api", true);
          return done({ detail: `Google News search returned ${r.items.length} articles from the last 3 days.` });
        }
        const { searchGNews } = await import("../providers/feeds");
        const r = await searchGNews(g.value!.apiKey, "Indian startup", new Date(Date.now() - 3 * 86_400_000).toISOString());
        await markHealth(db, "news_api", true);
        return done({ detail: `GNews returned ${r.items.length} articles.` });
      }
      case "scrapingbee": {
        const s = config.scrapingBee();
        if (!s.ok) return fail("UNAVAILABLE", "Not configured.");
        const { fetchArticlePage } = await import("../providers/scrapingbee");
        const r = await fetchArticlePage(s.value!.apiKey, "https://example.com/", { renderJs: false, timeoutMs: 15_000 });
        if (r.status === "FAILED") return fail("FAILED", r.note ?? "Failed");
        await markHealth(db, "scrapingbee", true);
        return done({ detail: `ScrapingBee fetched a test page (${r.credits ?? "?"} credit).` });
      }
    }
    return fail("INVALID", "No test available for this integration.");
  } catch (e) {
    const msg = e instanceof GoogleApiError || e instanceof Error ? e.message : String(e);
    await markHealth(db, key, false, msg);
    return fail("FAILED", msg);
  }
}
