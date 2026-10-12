// Preview mode: a complete, isolated newsletter journey that runs entirely in
// the browser. It uses the same domain rules as the live server, but all data
// is fictional sample data stored in this browser's localStorage, and every
// external effect (email, Telegram, Calendar) is simulated and labelled so.
// Nothing here can reach a server, a subscriber, or a third-party API.

import { alternativesFor, analyzeArticles, type AnalysisResult } from "../domain/analysis";
import {
  addStory,
  confirmEdition,
  contentHash,
  editFraming,
  editStory,
  finalisationReport,
  moveStory,
  newId,
  removeStory,
  revokeApproval,
  setStoryReview,
  snapshotOf,
  storyFromCandidate,
  swapStory,
  type Actor,
  type FinalisationContext,
} from "../domain/edition";
import { renderEmail, DEFAULT_BRANDING } from "../domain/email-render";
import { historyDepthLabel, refsFromPreviousEditions, type CoveredRef } from "../domain/history";
import {
  addDays,
  currentPublishDate,
  DEFAULT_SCHEDULE,
  milestonesFor,
  type ScheduleConfig,
} from "../domain/schedule";
import { validateSelection } from "../domain/selection";
import { computeStage } from "../domain/stage";
import { STARTER_STYLE_GUIDE } from "../domain/style-guide";
import { contentFingerprint, fnv1a64 } from "../domain/text";
import type { Article, CommandResult, Edition } from "../domain/types";
import { normalizeUrl } from "../domain/url";
import {
  SAMPLE_ALT_COMMENTARY,
  SAMPLE_ARTICLES,
  SAMPLE_HISTORY,
  SAMPLE_PICKS,
  SAMPLE_SOURCES,
  SAMPLE_SUBSCRIBERS,
} from "../sample/sample-data";
import type {
  ActivityView,
  AlternativesView,
  ArchiveEdition,
  ArchiveView,
  ArticlesView,
  AudienceView,
  CalendarActionView,
  CampaignView,
  EmailPreviewView,
  IntegrationStatus,
  NotificationView,
  SettingsView,
  SubscriberRow,
  WeekView,
} from "../views";
import { calendarDetailsKey, type ActionMap, type ActionName, type ActionResult } from "./actions";
import type { DispatchClient } from "./client";

const STORAGE_KEY = "the-dispatch.preview.v1";
const PREVIEW_SENDER = "preview-sender@example.com (simulated)";

interface PreviewState {
  version: 1;
  createdAt: string;
  publishDate: string;
  articles: Article[];
  collectRuns: number;
  edition: Edition;
  archive: ArchiveEdition[];
  refs: CoveredRef[];
  subscribers: SubscriberRow[];
  campaign: CampaignView | null;
  notifications: NotificationView[];
  activity: ActivityView[];
  calendar: CalendarActionView[];
  styleGuide: { version: number; content: string; examples: string; isStarter: boolean; updatedAt: string };
  schedule: ScheduleConfig;
  sending: SettingsView["sending"];
  newsletter: SettingsView["newsletter"];
  sourcesEnabled: Record<string, boolean>;
  reminderSentFor: string | null;
}

function sampleArticles(windowStart: string, fetchedLabel: string): Article[] {
  const base = Date.parse(windowStart);
  return SAMPLE_ARTICLES.map((s) => {
    const url = `https://example.com/sample/${s.urlKey ?? s.key}${s.urlSuffix ?? ""}`;
    return {
      id: `art_${s.key}`,
      sourceId: null,
      publisher: s.publisher,
      url,
      normalizedUrl: normalizeUrl(url) ?? url,
      headline: s.headline,
      author: null,
      publishedAt: new Date(base + s.hoursAfterWindowStart * 3_600_000).toISOString(),
      fetchedAt: fetchedLabel,
      description: s.description,
      extractedText: s.extracted ? s.description : null,
      fingerprint: contentFingerprint(s.headline, s.description),
      extractionStatus: s.extracted ? "EXTRACTED" : "FEED_ONLY",
      provenance: "sample",
      topic: s.topic,
      topicOrigin: "sample",
      clusterId: null,
      evidenceNotes: [],
    } satisfies Article;
  });
}

function initialState(now: Date): PreviewState {
  const publishDate = currentPublishDate(now, DEFAULT_SCHEDULE);
  const m = milestonesFor(publishDate, DEFAULT_SCHEDULE);
  const archive: ArchiveEdition[] = SAMPLE_HISTORY.map((h) => {
    const date = addDays(publishDate, -7 * h.weeksAgo);
    return {
      id: `sample_hist_${h.issue}`,
      publishDate: date,
      issueNumber: h.issue,
      subject: h.subject,
      status: "SENT",
      origin: "sample",
      publishedAt: milestonesFor(date).sendAt,
      stories: h.stories.map((s) => ({ headline: s.headline, publisher: s.publisher, url: `https://example.com/sample/history/${s.slug}` })),
      delivery: null,
      inMemoryWindow: true,
    };
  });
  const refs: CoveredRef[] = archive.flatMap((e) =>
    e.stories.map((s) => ({ editionId: e.id, publishDate: e.publishDate, normalizedUrl: normalizeUrl(s.url) ?? s.url, headline: s.headline })),
  );
  return {
    version: 1,
    createdAt: now.toISOString(),
    publishDate,
    articles: sampleArticles(m.collectionWindowStart, "sample"),
    collectRuns: 1,
    edition: {
      id: `preview_${publishDate}`,
      publishDate,
      issueNumber: 104,
      subject: "",
      intro: "",
      status: "COLLECTING",
      revision: 0,
      stories: [],
      approval: null,
      generatedBy: null,
      draftNotes: [],
      lockVersion: 0,
      updatedAt: now.toISOString(),
    },
    archive,
    refs,
    subscribers: SAMPLE_SUBSCRIBERS.map((s, i) => ({
      id: `sub_sample_${i}`,
      email: s.email,
      name: s.name,
      status: s.status,
      reason: s.status === "UNSUBSCRIBED" ? "Used the unsubscribe link (sample)" : s.status === "BOUNCED" ? "Permanent bounce: mailbox does not exist (sample)" : null,
      updatedAt: now.toISOString(),
    })),
    campaign: null,
    notifications: [],
    activity: [{ id: newId("act"), at: now.toISOString(), actor: "preview", action: "preview.started", message: "Preview started with fictional sample data. Nothing here is sent anywhere." }],
    calendar: [],
    styleGuide: { version: 1, content: STARTER_STYLE_GUIDE, examples: "", isStarter: true, updatedAt: now.toISOString() },
    schedule: DEFAULT_SCHEDULE,
    sending: { fromName: DEFAULT_BRANDING.fromName, replyTo: "", dailyLimit: 500, accountType: "gmail" },
    newsletter: { name: DEFAULT_BRANDING.newsletterName, footer: DEFAULT_BRANDING.footer },
    sourcesEnabled: {},
    reminderSentFor: null,
  };
}

function load(now: Date): PreviewState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PreviewState;
      // A new week starts a fresh sample edition rather than showing stale dates.
      if (parsed.version === 1 && parsed.publishDate === currentPublishDate(now, parsed.schedule)) return parsed;
    }
  } catch {
    // Storage blocked or corrupt — fall through to a fresh in-memory preview.
  }
  return initialState(now);
}

function ok<T>(data: T, message?: string, simulated = false): ActionResult<T> {
  return { ok: true, data, message, simulated };
}
function err(code: string, message: string, current?: unknown): ActionResult<never> {
  return { ok: false, error: { code, message, current } };
}

export class PreviewEngine implements DispatchClient {
  readonly mode = "preview" as const;
  private _state: PreviewState | null = null;

  // Loaded lazily so server rendering never touches browser storage.
  private get state(): PreviewState {
    if (!this._state) {
      this._state = load(new Date());
      this.save();
    }
    return this._state;
  }
  private set state(next: PreviewState) {
    this._state = next;
  }

  private save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Private browsing / storage disabled: preview still works for this tab.
    }
  }

  private actor(): Actor {
    return { actor: "preview-editor", now: new Date() };
  }

  private log(action: string, message: string) {
    this.state.activity = [{ id: newId("act"), at: new Date().toISOString(), actor: "preview", action, message }, ...this.state.activity].slice(0, 60);
  }

  private analysis(): AnalysisResult {
    const m = milestonesFor(this.state.publishDate, this.state.schedule);
    const { refs } = refsFromPreviousEditions(this.state.refs, this.state.publishDate);
    const result = analyzeArticles(this.state.articles, { refs, windowStart: m.collectionWindowStart, edition: this.state.edition, now: new Date() });
    // Attach the prewritten sample commentary to alternatives so swaps are usable.
    for (const c of result.candidates) {
      const key = c.articleId.replace(/^art_/, "");
      const pick = SAMPLE_PICKS.find((p) => p.key === key);
      const text = pick?.commentary ?? SAMPLE_ALT_COMMENTARY[key];
      if (text) {
        c.commentary = text;
        c.commentaryOrigin = "sample";
      }
      if (pick) {
        c.rationale = pick.rationale;
        c.rationaleOrigin = "sample";
      }
    }
    return result;
  }

  private ctx(): FinalisationContext {
    return {
      eligibleRecipients: this.state.subscribers.filter((s) => s.status === "ACTIVE").length,
      sendingReady: true,
      dailyLimit: this.state.sending.dailyLimit,
    };
  }

  private apply(result: CommandResult): ActionResult<null> {
    if (!result.ok) return err(result.error.code, result.error.message, result.error.current);
    this.state.edition = { ...result.edition, lockVersion: result.edition.lockVersion + 1 };
    for (const e of result.events) this.log(e.action, e.message);
    this.save();
    return ok(null, result.events.map((e) => e.message).join(" ") || undefined);
  }

  // ---------- Views ----------

  async week(): Promise<WeekView> {
    const s = this.state;
    const ed = s.edition;
    const a = this.analysis();
    const m = milestonesFor(s.publishDate, s.schedule);
    const report = ed.stories.length ? finalisationReport(ed, this.ctx()) : null;
    const { editions } = refsFromPreviousEditions(s.refs, s.publishDate);
    const attention: WeekView["attention"] = [];
    if (ed.approval?.revokedAt && ed.status === "IN_REVIEW") {
      attention.push({ id: "revoked", tone: "warn", title: "Approval withdrawn", detail: `${ed.approval.revokedReason ?? "The content changed"}. Confirm the edition again when ready.` });
    }
    if (s.reminderSentFor === ed.id && !["SCHEDULED", "SENDING", "SENT"].includes(ed.status)) {
      attention.push({ id: "reminder", tone: "warn", title: "Final confirmation still needed", detail: "The Wednesday 10 PM reminder has fired (simulated). Nothing will be sent until you confirm." });
    }
    attention.push({ id: "history", tone: "info", title: "History check is partial", detail: historyDepthLabel(editions.length) + " (sample archive)." });
    const stage = computeStage({
      edition: ed,
      articleCount: a.counts.total,
      eligibleCount: a.counts.eligible,
      report,
      aiAvailable: true,
      campaign: s.campaign,
      timezone: s.schedule.timezone,
      draftAt: m.draftAt,
      jobRunning: null,
    });
    if (stage.primary.kind === "generate") stage.primary = { kind: "generate", label: "Generate sample draft", hint: "Uses prewritten sample picks — Gemini is not called in preview" };
    return {
      mode: "preview",
      now: new Date().toISOString(),
      timezone: s.schedule.timezone,
      edition: ed,
      contentHash: ed.stories.length ? contentHash(ed) : null,
      finalisation: report,
      milestones: m,
      stage,
      attention,
      collection: {
        total: a.counts.total,
        eligible: a.counts.eligible,
        duplicates: a.counts.duplicates,
        sameEvent: a.counts.sameEvent,
        covered: a.counts.covered,
        flagged: a.counts.flagged,
        lastRunAt: null,
        lastRunStatus: "SAMPLE",
        sourcesOk: SAMPLE_SOURCES.length,
        sourcesFailed: 0,
        isSample: true,
      },
      history: { checked: editions.length, depth: 4, label: historyDepthLabel(editions.length) },
      recipients: { eligible: this.ctx().eligibleRecipients, sender: PREVIEW_SENDER, dailyLimit: s.sending.dailyLimit, accountLabel: "Simulated sender" },
      capabilities: { ai: false, aiReason: "Preview uses prewritten sample commentary", telegram: true, email: true, calendar: true, calendarAvailability: false },
      campaign: s.campaign,
      notifications: s.notifications,
      activity: s.activity,
      calendarActions: s.calendar,
      job: null,
      defaultSendAt: m.sendAt,
      sendTimePassed: Date.now() > Date.parse(m.sendAt),
      styleGuideVersion: s.styleGuide.version,
    };
  }

  async articles(): Promise<ArticlesView> {
    const s = this.state;
    const a = this.analysis();
    const m = milestonesFor(s.publishDate, s.schedule);
    return {
      mode: "preview",
      timezone: s.schedule.timezone,
      publishDate: s.publishDate,
      windowStart: m.collectionWindowStart,
      rows: a.rows
        .map((r) => ({
          id: r.article.id,
          headline: r.article.headline,
          publisher: r.article.publisher,
          url: r.article.url,
          publishedAt: r.article.publishedAt,
          fetchedAt: null,
          topic: r.topic,
          provenance: r.article.provenance,
          extractionStatus: r.article.extractionStatus,
          evidenceNotes: r.article.evidenceNotes,
          status: r.status,
          reason: r.reason,
          clusterId: r.clusterId,
          clusterSize: r.clusterSize,
          draftPosition: r.draftPosition,
          historyFlag: r.history.status === "FLAGGED" ? r.history.reason : null,
          description: r.article.description,
        }))
        .sort((x, y) => (y.publishedAt ?? "").localeCompare(x.publishedAt ?? "")),
      sources: SAMPLE_SOURCES.map((src, i) => ({
        id: `sample_src_${i}`,
        kind: src.kind,
        name: src.name,
        locator: "Sample — not a real feed",
        enabled: s.sourcesEnabled[`sample_src_${i}`] ?? true,
        verifiedNote: "Sample source",
        lastRunAt: null,
        lastStatus: "SKIPPED",
        lastError: null,
        lastItemCount: null,
      })),
      runs: [{ id: "sample_run", trigger: "sample", status: "SAMPLE", startedAt: s.createdAt, finishedAt: s.createdAt, summary: `Sample collection loaded (${s.collectRuns} run${s.collectRuns === 1 ? "" : "s"}). These articles were not fetched from the internet.` }],
      counts: { total: a.counts.total, eligible: a.counts.eligible, duplicates: a.counts.duplicates, sameEvent: a.counts.sameEvent, covered: a.counts.covered, outOfWindow: a.counts.outOfWindow },
      canAddToDraft: !["SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED"].includes(s.edition.status),
      draftSize: s.edition.stories.length,
      isSample: true,
      newsApiNote: null,
    };
  }

  async archive(): Promise<ArchiveView> {
    const s = this.state;
    const { editions } = refsFromPreviousEditions(s.refs, s.publishDate);
    return {
      mode: "preview",
      timezone: s.schedule.timezone,
      editions: [...s.archive].sort((a, b) => b.publishDate.localeCompare(a.publishDate)).map((e) => ({ ...e, inMemoryWindow: editions.includes(e.id) })),
      history: { checked: editions.length, depth: 4, label: historyDepthLabel(editions.length) },
    };
  }

  async audience(): Promise<AudienceView> {
    const s = this.state;
    const counts = { ACTIVE: 0, UNSUBSCRIBED: 0, BOUNCED: 0, total: s.subscribers.length };
    for (const sub of s.subscribers) counts[sub.status]++;
    return {
      mode: "preview",
      counts,
      subscribers: s.subscribers,
      truncated: false,
      feedback: [{ id: "fb_sample", at: s.createdAt, kind: "PERMANENT_BOUNCE", recipient: "no-such-mailbox@example.com", detail: "Sample bounce: 550 5.1.1 mailbox does not exist → suppressed" }],
      feedbackEnabled: false,
      sending: { account: PREVIEW_SENDER, dailyLimit: s.sending.dailyLimit, accountLabel: "Simulated sender" },
      lastCampaign: s.campaign,
    };
  }

  async settings(): Promise<SettingsView> {
    const s = this.state;
    const sim = (key: IntegrationStatus["key"], name: string, purpose: string, optional = false): IntegrationStatus => ({
      key, name, purpose, optional, state: "SIMULATED", detail: "Preview mode: simulated, nothing is sent or fetched.",
      lastSuccessAt: null, lastError: null, missingEnv: [], actions: [],
    });
    return {
      mode: "preview",
      integrations: [
        sim("database", "Database", "Durable storage for articles, drafts, approvals and deliveries"),
        sim("rss", "RSS feeds", "Routine collection from publisher feeds"),
        sim("news_api", "News search (GNews)", "Query-based discovery", true),
        sim("scrapingbee", "ScrapingBee", "Fetches full article pages when feed text is too thin", true),
        sim("gemini", "Gemini Flash", "Selection, topics and commentary"),
        sim("telegram", "Telegram", "Draft review, approvals and reminders"),
        sim("gmail", "Gmail", "Sends the approved edition"),
        sim("gmail_feedback", "Gmail delivery feedback", "Reads bounce notices to suppress dead addresses", true),
        sim("calendar", "Google Calendar", "Optional review blocks and follow-up meetings", true),
      ],
      styleGuide: s.styleGuide,
      schedule: s.schedule,
      sending: s.sending,
      newsletter: s.newsletter,
      telegram: { linked: false, linkCode: null, botUsername: null },
      cron: { externalSchedulerUrl: null, note: "Preview has no scheduler. Use the demo controls to run each step." },
      demoControls: true,
    };
  }

  async alternatives(storyId: string): Promise<AlternativesView> {
    return { storyId, alternatives: alternativesFor(this.state.edition, storyId, this.analysis().candidates) };
  }

  async emailPreview(): Promise<EmailPreviewView> {
    const s = this.state;
    const ed = s.edition;
    const m = milestonesFor(s.publishDate, s.schedule);
    const r = renderEmail(snapshotOf(ed), { newsletterName: s.newsletter.name, fromName: s.sending.fromName, footer: s.newsletter.footer }, { unsubscribeUrl: "https://example.com/unsubscribe/preview" });
    return {
      ...r,
      revision: ed.revision,
      contentHash: contentHash(ed),
      sender: PREVIEW_SENDER,
      recipients: this.ctx().eligibleRecipients,
      defaultSendAt: m.sendAt,
      sendTimePassed: Date.now() > Date.parse(m.sendAt) - 60_000,
      timezone: s.schedule.timezone,
      report: finalisationReport(ed, this.ctx()),
    };
  }

  async job() {
    return null;
  }

  // ---------- Actions ----------

  async run<K extends ActionName>(name: K, input: ActionMap[K]["input"]): Promise<ActionResult<ActionMap[K]["output"]>> {
    const result = await this.dispatch(name, input as never);
    return result as ActionResult<ActionMap[K]["output"]>;
  }

  private async dispatch(name: ActionName, input: never): Promise<ActionResult<unknown>> {
    const s = this.state;
    const at = this.actor();
    const i = input as Record<string, unknown>;
    switch (name) {
      case "collect": {
        // Re-loading the same sample articles demonstrates idempotent storage.
        const before = s.articles.length;
        s.collectRuns++;
        this.log("collect.sample", `Sample collection re-run: 0 new articles, ${before} already stored (no duplicates created).`);
        this.save();
        return ok({}, "Sample collection re-run — 0 new, nothing duplicated. Preview never fetches live feeds.", true);
      }
      case "generateDraft": {
        if (s.edition.stories.length && !i.replace) return err("INVALID", "A draft already exists. Replacing it would discard your edits.");
        if (["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT"].includes(s.edition.status)) return err("FROZEN", "This edition is already confirmed.");
        const a = this.analysis();
        const byKey = new Map(a.candidates.map((c) => [c.articleId, c]));
        const picks = SAMPLE_PICKS.map((p) => byKey.get(`art_${p.key}`)).filter((c): c is NonNullable<typeof c> => !!c);
        const issues = validateSelection(
          picks.map((c) => ({ articleId: c.articleId })),
          new Map(a.candidates.map((c) => [c.articleId, { articleId: c.articleId, clusterId: c.clusterId, topic: c.topic, score: c.score }])),
        );
        const stories = picks.map((c, idx) => ({ ...storyFromCandidate(c, idx + 1), styleGuideVersion: s.styleGuide.version }));
        s.edition = {
          ...s.edition,
          status: "IN_REVIEW",
          revision: s.edition.revision + 1,
          subject: "The Dispatch: credit pays the bills",
          intro: "This week: lenders face a guarantee squeeze, seed money moves beyond the metros, and subsidised compute goes unused. (Sample introduction.)",
          stories,
          approval: null,
          generatedBy: "sample",
          draftNotes: [
            "Sample draft: the selection and commentary were prewritten for this preview. Gemini was not called.",
            ...issues.map((x) => x.message),
          ],
          updatedAt: at.now.toISOString(),
        };
        this.log("draft.sample", `Sample draft assembled: ${stories.length} stories validated against count, topic and duplicate-event rules.`);
        this.save();
        return ok({}, "Sample draft ready for review.", true);
      }
      case "editStory": {
        const r = this.apply(editStory(s.edition, i as never, at));
        return r.ok ? ok({ story: this.state.edition.stories.find((x) => x.id === i.storyId)!, revision: this.state.edition.revision }) : r;
      }
      case "setStoryReview":
        return this.apply(setStoryReview(s.edition, i as never, at));
      case "removeStory":
        return this.apply(removeStory(s.edition, i as never, at));
      case "moveStory":
        return this.apply(moveStory(s.edition, i as never, at));
      case "editFraming": {
        if (i.baseRevision !== s.edition.revision) return err("CONFLICT", "The edition changed since you started editing. Your text is kept — save again to apply it.");
        const r = this.apply(editFraming(s.edition, i as never, at));
        return r.ok ? ok({ revision: s.edition.revision }) : r;
      }
      case "swapStory": {
        const cand = this.analysis().candidates.find((c) => c.articleId === i.articleId);
        if (!cand) return err("NOT_FOUND", "That article is not an eligible alternative.");
        return this.apply(swapStory(s.edition, { storyId: i.storyId as string, candidate: cand }, at));
      }
      case "addStory": {
        const cand = this.analysis().candidates.find((c) => c.articleId === i.articleId);
        if (!cand) return err("NOT_FOUND", "That article is not eligible (duplicate, same event, or previously covered).");
        const r = addStory(s.edition, { candidate: cand }, at);
        if (r.ok && !s.edition.generatedBy) r.edition.generatedBy = "manual";
        if (r.ok && !r.edition.subject) r.edition.subject = "The Dispatch";
        return this.apply(r);
      }
      case "regenerateCommentary":
        return err("UNAVAILABLE", "Regenerating commentary needs Gemini, which preview mode never calls. Edit the text directly, or try it in connected mode.");
      case "confirmEdition": {
        const r = this.apply(confirmEdition(s.edition, { ...(i as unknown as ActionMap["confirmEdition"]["input"]), channel: "dashboard", sender: PREVIEW_SENDER }, this.ctx(), at));
        if (r.ok) {
          this.notify("CONFIRMATION", "IN_APP", "SIMULATED", "Edition confirmed in preview. No email will be sent — use “Simulate delivery” to see the delivery report.");
          return ok(null, "Confirmed and scheduled (preview — nothing will actually be sent).", true);
        }
        return r;
      }
      case "revokeApproval":
        return this.apply(revokeApproval(s.edition, i as never, at));
      case "sendDraftToTelegram": {
        if (!s.edition.stories.length) return err("INVALID", "There is no draft to send yet.");
        this.notify("DRAFT_DELIVERY", "TELEGRAM", "SIMULATED", `Preview: a Telegram review message for revision ${s.edition.revision} would be sent here. No message was sent.`);
        return ok(null, "Simulated — no Telegram message was sent.", true);
      }
      case "runScheduledNow":
        return this.runTask(i.task as string);
      case "retryUnknownDeliveries":
        return ok(null, "No uncertain deliveries in preview.", true);
      case "addSubscribers": {
        const lines = String(i.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        let added = 0, skipped = 0;
        const invalid: string[] = [];
        for (const line of lines) {
          const [emailRaw, ...rest] = line.split(/[,;\t]/);
          const email = emailRaw.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { invalid.push(emailRaw.trim()); continue; }
          if (s.subscribers.some((x) => x.email === email)) { skipped++; continue; }
          s.subscribers.push({ id: newId("sub"), email, name: rest.join(" ").trim() || null, status: "ACTIVE", reason: null, updatedAt: at.now.toISOString() });
          added++;
        }
        this.save();
        return ok({ added, skipped, invalid }, `Added ${added}. ${skipped ? `${skipped} already on the list (status kept).` : ""}`);
      }
      case "setSubscriberStatus": {
        const sub = s.subscribers.find((x) => x.id === i.id);
        if (!sub) return err("NOT_FOUND", "Subscriber not found.");
        if (i.status === "ACTIVE" && sub.status === "UNSUBSCRIBED") return err("INVALID", "People who unsubscribed must opt back in themselves.");
        sub.status = i.status as SubscriberRow["status"];
        sub.reason = i.status === "UNSUBSCRIBED" ? "Removed by editor" : "Reactivated by editor";
        sub.updatedAt = at.now.toISOString();
        this.save();
        return ok(null);
      }
      case "importHistory":
        return err("UNAVAILABLE", "Historical import is available in connected mode. The preview already includes a three-edition sample archive.");
      case "saveStyleGuide": {
        s.styleGuide = { version: s.styleGuide.version + 1, content: String(i.content).slice(0, 8000), examples: String(i.examples ?? "").slice(0, 20000), isStarter: false, updatedAt: at.now.toISOString() };
        this.log("style.saved", `Style guide saved as version ${s.styleGuide.version}.`);
        this.save();
        return ok({ version: s.styleGuide.version });
      }
      case "saveSchedule":
        s.schedule = { ...(i.schedule as ScheduleConfig), timezone: (i.schedule as ScheduleConfig).timezone || "Asia/Kolkata" };
        this.save();
        return ok(null, "Schedule saved (preview only).");
      case "saveSending": {
        const x = i as unknown as ActionMap["saveSending"]["input"];
        s.sending = { fromName: x.fromName, replyTo: x.replyTo, dailyLimit: x.dailyLimit, accountType: x.accountType };
        s.newsletter = { name: x.newsletterName, footer: x.footer };
        this.save();
        return ok(null, "Saved (preview only).");
      }
      case "toggleSource":
        s.sourcesEnabled[i.id as string] = !!i.enabled;
        this.save();
        return ok(null);
      case "addSource":
      case "testIntegration":
      case "registerTelegramWebhook":
      case "createTelegramLinkCode":
        return err("UNAVAILABLE", "This works in connected mode. Preview never contacts external services.");
      case "saveCalendarDraft": {
        const x = i as unknown as ActionMap["saveCalendarDraft"]["input"];
        const id = x.id ?? newId("cal");
        const existing = s.calendar.find((c) => c.id === id);
        if (existing && existing.status !== "DRAFT") return err("INVALID", "This calendar action was already confirmed.");
        const view: CalendarActionView = {
          id, kind: x.kind, status: "DRAFT", storyId: x.storyId ?? null, title: x.title.slice(0, 200), startAt: x.startAt,
          durationMinutes: x.durationMinutes, timezone: s.schedule.timezone, attendees: x.kind === "MEETING" ? x.attendees : [],
          agenda: x.agenda.slice(0, 4000), withMeet: x.kind === "MEETING" && x.withMeet, reminderMinutes: x.reminderMinutes,
          eventUrl: null, meetUrl: null, error: null, confirmedAt: null,
        };
        s.calendar = existing ? s.calendar.map((c) => (c.id === id ? view : c)) : [view, ...s.calendar];
        this.save();
        return ok({ id }, "Draft saved in this browser.");
      }
      case "suggestMeeting": {
        const story = s.edition.stories.find((x) => x.id === i.storyId);
        if (!story) return err("NOT_FOUND", "Story not found.");
        return ok({
          title: `Follow-up: ${story.headline.slice(0, 80)}`,
          agenda: `- What we know from the reporting so far\n- Open questions to verify\n- Who else should we speak to?\n- Decide: follow-up piece or mention next week`,
          origin: "template" as const,
        }, "Template suggestion (Gemini is not called in preview).");
      }
      case "checkAvailability":
        return ok({ checked: false, conflicts: [], note: "Preview can't see a real calendar, so availability was not checked." });
      case "bookCalendarAction": {
        const c = s.calendar.find((x) => x.id === i.id);
        if (!c) return err("NOT_FOUND", "Calendar draft not found.");
        if (i.confirm !== true) return err("INVALID", "Booking requires explicit confirmation.");
        if (c.status === "SIMULATED") return ok(null, "Already simulated — no duplicate created.", true);
        if (fnv1a64(calendarDetailsKey(c)) !== i.detailsHash) return err("STALE", "The details changed since you reviewed them. Review and confirm again.");
        c.status = "SIMULATED";
        c.confirmedAt = at.now.toISOString();
        this.log("calendar.simulated", `Simulated calendar ${c.kind === "MEETING" ? "meeting" : "reminder"} “${c.title}”. No event was created and nobody was invited.`);
        this.save();
        return ok(null, "Simulated — no calendar event was created and no invitations were sent.", true);
      }
      case "deleteCalendarDraft":
        s.calendar = s.calendar.filter((c) => c.id !== i.id || c.status !== "DRAFT");
        this.save();
        return ok(null);
      case "resetPreview":
        try {
          globalThis.localStorage?.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
        this.state = initialState(new Date());
        this.save();
        return ok(null, "Preview reset to the starting sample.");
    }
    return err("UNKNOWN", `Unknown action ${name}`);
  }

  private notify(kind: NotificationView["kind"], channel: NotificationView["channel"], status: NotificationView["status"], detail: string) {
    this.state.notifications = [{ id: newId("ntf"), kind, channel, status, detail, at: new Date().toISOString() }, ...this.state.notifications].slice(0, 30);
    this.save();
  }

  private runTask(task: string): ActionResult<{ detail: string }> {
    const s = this.state;
    const ed = s.edition;
    if (task === "reminder") {
      if (s.reminderSentFor === ed.id) return ok({ detail: "Already reminded for this edition." }, "The reminder runs once per edition — it already fired.", true);
      if (["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT"].includes(ed.status)) {
        return ok({ detail: "Already confirmed — no reminder needed." }, "No reminder: the edition is already confirmed.", true);
      }
      s.reminderSentFor = ed.id;
      this.notify("REMINDER", "TELEGRAM", "SIMULATED", "Wednesday 10 PM reminder (simulated): final confirmation has not arrived. The edition will NOT be sent without it.");
      this.log("reminder.simulated", "Missing-approval reminder fired (simulated). No send was triggered.");
      return ok({ detail: "Reminder simulated." }, "Reminder simulated. Silence never sends the newsletter.", true);
    }
    if (task === "draft_delivery") {
      if (!ed.stories.length) return err("INVALID", "No draft to deliver yet — generate it first.");
      this.notify("DRAFT_DELIVERY", "TELEGRAM", "SIMULATED", `Draft delivery (simulated): revision ${ed.revision}, ${ed.stories.length} stories. No Telegram message was sent.`);
      return ok({ detail: "Simulated." }, "Draft delivery simulated.", true);
    }
    if (task === "send_due") {
      if (ed.status !== "SCHEDULED" || !ed.approval) {
        this.log("send.blocked", "Send check ran: no valid approval, so nothing was sent.");
        this.save();
        return err("BLOCKED", "Nothing to send: the edition has no valid final approval. Silence or a passed deadline never sends it.");
      }
      if (ed.approval.revision !== ed.revision || ed.approval.contentHash !== contentHash(ed)) {
        return err("BLOCKED", "The approved revision does not match the current content. Delivery blocked.");
      }
      const counts: CampaignView["counts"] = { ACCEPTED: 0, SKIPPED_UNSUBSCRIBED: 0 };
      for (const sub of s.subscribers) {
        if (sub.status === "ACTIVE") counts.ACCEPTED = (counts.ACCEPTED ?? 0) + 1;
        else counts.SKIPPED_UNSUBSCRIBED = (counts.SKIPPED_UNSUBSCRIBED ?? 0) + 1;
      }
      const now = new Date().toISOString();
      s.campaign = { id: newId("cmp"), revision: ed.revision, status: "SENT", startedAt: now, finishedAt: now, pausedReason: null, counts, total: s.subscribers.length, simulated: true };
      s.edition = { ...ed, status: "SENT" };
      const snap = snapshotOf(ed);
      s.archive = [
        { id: ed.id, publishDate: ed.publishDate, issueNumber: ed.issueNumber, subject: ed.subject, status: "SENT", origin: "sample", publishedAt: now, stories: snap.stories.map((x) => ({ headline: x.headline, publisher: x.publisher, url: x.url })), delivery: { accepted: counts.ACCEPTED ?? 0, failed: 0, unknown: 0, total: s.subscribers.length }, inMemoryWindow: false },
        ...s.archive.filter((e) => e.id !== ed.id),
      ];
      s.refs = [...s.refs, ...snap.stories.map((x) => ({ editionId: ed.id, publishDate: ed.publishDate, normalizedUrl: normalizeUrl(x.url) ?? x.url, headline: x.headline }))];
      this.notify("CONFIRMATION", "EMAIL", "SIMULATED", `Delivery simulated for revision ${ed.revision}: ${counts.ACCEPTED} would be sent, ${counts.SKIPPED_UNSUBSCRIBED} suppressed. No email left this browser.`);
      this.log("send.simulated", "Delivery simulated from the approved snapshot.");
      return ok({ detail: "Simulated delivery." }, "Delivery simulated — no email was sent.", true);
    }
    if (task === "feedback") return ok({ detail: "Preview has no mailbox." }, "Preview has no mailbox to check.", true);
    return ok({ detail: "Nothing to do." });
  }
}
