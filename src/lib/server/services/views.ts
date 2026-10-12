import "server-only";
import { alternativesFor } from "../../domain/analysis";
import { contentHash, finalisationReport, snapshotOf } from "../../domain/edition";
import { renderEmail } from "../../domain/email-render";
import { historyDepthLabel, refsFromPreviousEditions } from "../../domain/history";
import { milestonesFor } from "../../domain/schedule";
import { computeStage } from "../../domain/stage";
import type {
  AlternativesView,
  ArchiveView,
  ArticlesView,
  AttentionItem,
  AudienceView,
  EmailPreviewView,
  IntegrationStatus,
  SettingsView,
  WeekView,
} from "../../views";
import { config, WORKSPACE_ID } from "../config";
import { iso, type Db } from "../db/client";
import { listSources, recentRuns } from "../repo/articles";
import { archiveEditions, coveredRefs } from "../repo/editions";
import { healthMap, jobView, latestJob, listSubscribers, notificationsFor, recentActivity, subscriberCounts } from "../repo/ops";
import { getSettings, getStyleGuide } from "../repo/settings";
import { listCalendarActions } from "./calendar";
import { campaignView } from "./delivery";
import { currentEdition, finalisationContext, liveAnalysis } from "./editorial";
import { getGoogleConnection, hasFeature } from "./google-auth";

const ACCOUNT_LABEL = { gmail: "Personal Gmail (~500/day)", workspace: "Google Workspace (~2,000/day)", custom: "Custom limit" } as const;

export async function weekView(db: Db): Promise<WeekView> {
  const now = new Date();
  const [settings, ed, ctx, style, google] = await Promise.all([getSettings(db), currentEdition(db, now), finalisationContext(db), getStyleGuide(db), getGoogleConnection(db)]);
  const tz = settings.schedule.timezone;
  const m = milestonesFor(ed.publishDate, settings.schedule);
  const analysis = await liveAnalysis(db, ed, now);
  const { editions: historyEditions } = refsFromPreviousEditions(await coveredRefs(db), ed.publishDate);
  const job = await latestJob(db, ["COLLECT", "GENERATE_DRAFT"], "");
  const activeJob = job && (job.status === "RUNNING" || job.status === "QUEUED") && Date.parse(job.runAt) <= Date.now() ? job : job?.status === "FAILED" && Date.now() - Date.parse(job.updatedAt) < 3_600_000 ? job : null;
  const runs = await recentRuns(db, 1);
  const sources = await listSources(db);
  const report = ed.stories.length ? finalisationReport(ed, ctx) : null;
  const campaign = await campaignView(db, ed.id);
  const notifications = await notificationsFor(db, ed.id);
  const gemini = config.gemini();
  const telegramReady = config.telegram().ok && !!(config.telegram().value!.ownerChatId ?? settings.telegramChatId);

  const attention: AttentionItem[] = [];
  if (!ctx.sendingReady && !report) attention.push({ id: "gmail", tone: "warn", title: "Email sending isn't ready", detail: ctx.sendingIssue ?? "", href: "/settings" });
  if (ed.approval?.revokedAt && ed.status === "IN_REVIEW") attention.push({ id: "revoked", tone: "warn", title: "Approval withdrawn", detail: `${ed.approval.revokedReason}. Confirm the edition again when ready.` });
  const reminder = notifications.find((n) => n.kind === "REMINDER");
  if (reminder && !["SCHEDULED", "SENDING", "SENT"].includes(ed.status)) attention.push({ id: "reminder", tone: "warn", title: "Final confirmation still needed", detail: reminder.detail });
  const failedNote = notifications.find((n) => n.status === "FAILED" && Date.now() - Date.parse(n.at) < 86_400_000);
  if (failedNote) attention.push({ id: "fail", tone: "error", title: "Something needs a retry", detail: failedNote.detail });
  const failedSources = sources.filter((s) => s.lastStatus === "FAILED").length;
  if (failedSources) attention.push({ id: "sources", tone: "info", title: `${failedSources} source${failedSources > 1 ? "s" : ""} failed on the last collection`, detail: "Other sources were collected normally.", href: "/articles" });
  if (!gemini.ok) attention.push({ id: "gemini", tone: "info", title: "Gemini isn't connected", detail: "Drafts won't be generated automatically. You can still build the edition by hand from Articles.", href: "/settings" });
  if (historyEditions.length < 4) attention.push({ id: "history", tone: "info", title: "History check is partial", detail: `${historyDepthLabel(historyEditions.length)}. Import past editions in Archive to improve it (optional).`, href: "/archive" });

  return {
    mode: "live",
    now: now.toISOString(),
    timezone: tz,
    edition: ed,
    contentHash: ed.stories.length ? contentHash(ed) : null,
    finalisation: report,
    milestones: m,
    stage: computeStage({ edition: ed, articleCount: analysis.counts.total, eligibleCount: analysis.counts.eligible, report, aiAvailable: gemini.ok, campaign, timezone: tz, draftAt: m.draftAt, jobRunning: activeJob && activeJob.status !== "FAILED" ? activeJob.kind : null }),
    attention,
    collection: {
      total: analysis.counts.total, eligible: analysis.counts.eligible, duplicates: analysis.counts.duplicates, sameEvent: analysis.counts.sameEvent,
      covered: analysis.counts.covered, flagged: analysis.counts.flagged, lastRunAt: runs[0]?.startedAt ?? null, lastRunStatus: runs[0]?.status ?? null,
      sourcesOk: sources.filter((s) => s.lastStatus === "OK").length, sourcesFailed: failedSources, isSample: false,
    },
    history: { checked: historyEditions.length, depth: 4, label: historyDepthLabel(historyEditions.length) },
    recipients: { eligible: ctx.eligibleRecipients, sender: ctx.sender, dailyLimit: settings.sending.dailyLimit, accountLabel: ACCOUNT_LABEL[settings.sending.accountType] },
    capabilities: {
      ai: gemini.ok,
      aiReason: gemini.ok ? null : "GEMINI_API_KEY not set",
      telegram: telegramReady,
      email: ctx.sendingReady,
      calendar: hasFeature(google, "calendar"),
      calendarAvailability: hasFeature(google, "calendar"),
    },
    campaign,
    notifications,
    activity: await recentActivity(db, 40),
    calendarActions: await listCalendarActions(db, ed.id),
    job: jobView(activeJob),
    defaultSendAt: m.sendAt,
    sendTimePassed: Date.now() > Date.parse(m.sendAt) - 60_000,
    styleGuideVersion: style.version,
  };
}

export async function articlesView(db: Db): Promise<ArticlesView> {
  const settings = await getSettings(db);
  const ed = await currentEdition(db);
  const m = milestonesFor(ed.publishDate, settings.schedule);
  const a = await liveAnalysis(db, ed);
  const gnews = config.newsApi();
  return {
    mode: "live",
    timezone: settings.schedule.timezone,
    publishDate: ed.publishDate,
    windowStart: m.collectionWindowStart,
    rows: a.rows
      .map((r) => ({
        id: r.article.id, headline: r.article.headline, publisher: r.article.publisher, url: r.article.url, publishedAt: r.article.publishedAt,
        fetchedAt: r.article.fetchedAt, topic: r.topic, provenance: r.article.provenance, extractionStatus: r.article.extractionStatus,
        evidenceNotes: r.article.evidenceNotes, status: r.status, reason: r.reason, clusterId: r.clusterId, clusterSize: r.clusterSize,
        draftPosition: r.draftPosition, historyFlag: r.history.status === "FLAGGED" ? r.history.reason : null, description: r.article.description,
      }))
      .sort((x, y) => (y.publishedAt ?? y.fetchedAt ?? "").localeCompare(x.publishedAt ?? x.fetchedAt ?? "")),
    sources: await listSources(db),
    runs: await recentRuns(db),
    counts: { total: a.counts.total, eligible: a.counts.eligible, duplicates: a.counts.duplicates, sameEvent: a.counts.sameEvent, covered: a.counts.covered, outOfWindow: a.counts.outOfWindow },
    canAddToDraft: !["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED", "DRAFTING"].includes(ed.status),
    draftSize: ed.stories.length,
    isSample: false,
    newsApiNote: !gnews.ok
      ? "News search is off (GNEWS_API_KEY not set). RSS collection still runs."
      : gnews.value!.plan === "free"
        ? "GNews free plan: results are delayed by about 12 hours and limited to 10 per query. The free plan is for non-commercial use."
        : null,
  };
}

export async function archiveView(db: Db): Promise<ArchiveView> {
  const settings = await getSettings(db);
  const ed = await currentEdition(db);
  const { editions: memory } = refsFromPreviousEditions(await coveredRefs(db), ed.publishDate);
  const rows = await archiveEditions(db);
  return {
    mode: "live",
    timezone: settings.schedule.timezone,
    editions: rows.map(({ e, refs, delivery }) => ({
      id: String(e.id),
      publishDate: e.publish_date instanceof Date ? e.publish_date.toISOString().slice(0, 10) : String(e.publish_date).slice(0, 10),
      issueNumber: e.issue_number == null ? null : Number(e.issue_number),
      subject: String(e.subject ?? ""),
      status: String(e.status),
      origin: e.origin === "import" ? "import" : "sent",
      publishedAt: iso(e.published_at),
      stories: refs.map((r) => ({ headline: String(r.headline), publisher: String(r.publisher ?? ""), url: String(r.url ?? `https://${r.normalized_url}`) })),
      delivery: delivery ? { accepted: Number(delivery.accepted), failed: Number(delivery.failed), unknown: Number(delivery.unknown), total: Number(delivery.total) } : null,
      inMemoryWindow: memory.includes(String(e.id)),
    })),
    history: { checked: memory.length, depth: 4, label: historyDepthLabel(memory.length) },
  };
}

export async function audienceView(db: Db): Promise<AudienceView> {
  const [settings, counts, subs, google, ed] = await Promise.all([getSettings(db), subscriberCounts(db), listSubscribers(db, 300), getGoogleConnection(db), currentEdition(db)]);
  const fb = await db.query<Record<string, unknown>>(`select * from delivery_feedback where workspace_id = $1 order by processed_at desc limit 30`, [WORKSPACE_ID]);
  return {
    mode: "live",
    counts,
    subscribers: subs,
    truncated: counts.total > subs.length,
    feedback: fb.map((f) => ({ id: String(f.id), at: iso(f.processed_at)!, kind: String(f.kind), recipient: (f.recipient as string) ?? null, detail: String(f.detail ?? "") })),
    feedbackEnabled: hasFeature(google, "feedback"),
    sending: { account: google?.accountEmail ?? null, dailyLimit: settings.sending.dailyLimit, accountLabel: ACCOUNT_LABEL[settings.sending.accountType] },
    lastCampaign: await campaignView(db, ed.id),
  };
}

export async function integrationStatuses(db: Db | null): Promise<IntegrationStatus[]> {
  const health = db ? await healthMap(db) : new Map();
  const settings = db ? await getSettings(db) : null;
  const google = db ? await getGoogleConnection(db) : null;
  const h = (k: string) => health.get(k) ?? { lastSuccessAt: null, lastErrorAt: null, lastError: null };
  const recentError = (k: string) => {
    const x = h(k);
    return x.lastErrorAt && (!x.lastSuccessAt || x.lastErrorAt > x.lastSuccessAt) ? x.lastError : null;
  };
  const item = (key: IntegrationStatus["key"], name: string, purpose: string, optional: boolean, c: { ok: boolean; missing: string[] }, detail: string, actions: IntegrationStatus["actions"] = ["test"], setupHint = "Add the credentials below to turn it on.", healthKey: string = key): IntegrationStatus => {
    const err = recentError(healthKey);
    return {
      key, name, purpose, optional,
      state: !c.ok ? "NOT_CONNECTED" : err ? "NEEDS_ATTENTION" : "READY",
      detail: c.ok ? detail : setupHint,
      lastSuccessAt: h(healthKey).lastSuccessAt, lastError: err, missingEnv: c.missing, actions: c.ok ? actions : [],
    };
  };
  const gcfg = config.google();
  const googleItem = (key: "gmail" | "gmail_feedback" | "calendar", feature: "send" | "feedback" | "calendar", name: string, purpose: string, optional: boolean, extra: string): IntegrationStatus => {
    const granted = hasFeature(google, feature);
    const state: IntegrationStatus["state"] = !gcfg.ok || !db ? "NOT_CONNECTED" : google?.status === "NEEDS_ATTENTION" ? "NEEDS_ATTENTION" : granted ? "READY" : "NOT_CONNECTED";
    return {
      key, name, purpose, optional, state,
      detail: !gcfg.ok ? "Google OAuth credentials aren't configured." : state === "NEEDS_ATTENTION" ? `Reconnect needed: ${google?.lastError}` : granted ? `Connected as ${google?.accountEmail ?? "your Google account"}. ${extra}` : `Grant access with your Google account. ${extra}`,
      lastSuccessAt: h(key === "gmail" ? "gmail" : key).lastSuccessAt, lastError: state === "NEEDS_ATTENTION" ? google?.lastError ?? null : recentError(key),
      missingEnv: gcfg.missing, actions: !gcfg.ok || !db ? [] : state === "READY" ? ["test", "reconnect"] : state === "NEEDS_ATTENTION" ? ["reconnect"] : ["connect"],
    };
  };
  const tg = config.telegram();
  const gn = config.newsApi();
  return [
    item("database", "Database", "Durable storage for articles, drafts, approvals and deliveries", false, config.database(), `Using ${config.database().value?.url.startsWith("pglite:") ? "the embedded local database (development only)" : "Postgres"}.`, ["test"]),
    item("rss", "RSS feeds", "Routine collection from publisher feeds", false, { ok: true, missing: [] }, "Always on; no key needed. Source health is shown on the Articles page.", []),
    item("gemini", "Gemini Flash", "Selection, topics and commentary — the only AI used at runtime", false, config.gemini(), `Model: ${config.gemini().value?.model} (set GEMINI_MODEL to change).`, ["test"], "Add a Gemini API key from Google AI Studio. Until then, build drafts by hand from Articles."),
    {
      ...item("telegram", "Telegram", "Draft review, story actions, final confirmation and reminders", false, tg, settings?.telegramChatId || tg.value?.ownerChatId ? "Linked to your chat." : "Bot configured — link your chat below, then register the webhook.", ["test", "register_webhook"], "Create a bot with @BotFather and set its token and a webhook secret. Until then, drafts and reminders appear on the dashboard."),
    },
    googleItem("gmail", "send", "Gmail", "Sends the approved edition, one recipient per message", false, "Permission: send only."),
    item("news_api", "News search (GNews)", "Query-based discovery alongside RSS", true, gn, gn.value?.plan === "free" ? "Free plan: ~12-hour delay, 10 results per query, non-commercial." : "Paid plan.", ["test"], "Optional. RSS collection works without it."),
    item("scrapingbee", "ScrapingBee", "Fetches full article pages when the feed text is too thin", true, config.scrapingBee(), `Budget: ${config.scrapingBee().value?.maxPagesPerRun ?? 25} pages per run; JavaScript rendering ${config.scrapingBee().value?.renderJs ? "on" : "off"}. Paywalls are not bypassed.`, ["test"], "Optional. Without it, stories rely on the feed summary and are marked as limited evidence."),
    googleItem("gmail_feedback", "feedback", "Gmail delivery feedback", "Reads bounce notices so dead addresses are suppressed", true, "Needs read access to the mailbox (a restricted Google scope)."),
    googleItem("calendar", "calendar", "Google Calendar", "Optional review blocks and confirmed follow-up meetings", true, "Never required for the newsletter."),
  ];
}

export async function settingsView(db: Db): Promise<SettingsView> {
  const [settings, style] = await Promise.all([getSettings(db), getStyleGuide(db)]);
  const t = config.telegram();
  const base = config.baseUrl();
  let botUsername: string | null = null;
  if (t.ok) {
    const { TelegramClient } = await import("../providers/telegram");
    botUsername = await new TelegramClient(t.value!.token).getMe().then((m) => m.username).catch(() => null);
  }
  return {
    mode: "live",
    integrations: await integrationStatuses(db),
    styleGuide: style,
    schedule: settings.schedule,
    sending: settings.sending,
    newsletter: settings.newsletter,
    telegram: {
      linked: !!(t.value?.ownerChatId ?? settings.telegramChatId),
      linkCode: settings.telegramLinkCode && settings.telegramLinkExpiresAt && Date.parse(settings.telegramLinkExpiresAt) > Date.now() ? settings.telegramLinkCode : null,
      botUsername,
    },
    cron: {
      externalSchedulerUrl: base ? `${base}/api/cron/tick` : null,
      note:
        "Scheduled work runs whenever /api/cron/tick is called with the cron secret. vercel.json calls it at each milestone (once a day per entry, compatible with the Hobby plan, which may fire up to an hour late). For exact timing, call the same endpoint every 5–10 minutes from an external scheduler (a GitHub Actions workflow is included). Every run recomputes what is due, so extra or duplicate calls are safe.",
    },
    demoControls: true,
  };
}

export async function alternativesView(db: Db, storyId: string): Promise<AlternativesView> {
  const ed = await currentEdition(db);
  return { storyId, alternatives: alternativesFor(ed, storyId, (await liveAnalysis(db, ed)).candidates) };
}

export async function emailPreviewView(db: Db): Promise<EmailPreviewView> {
  const [settings, ed, ctx] = await Promise.all([getSettings(db), currentEdition(db), finalisationContext(db)]);
  const m = milestonesFor(ed.publishDate, settings.schedule);
  const r = renderEmail(snapshotOf(ed), { newsletterName: settings.newsletter.name, fromName: settings.sending.fromName, footer: settings.newsletter.footer }, { unsubscribeUrl: `${config.baseUrl() ?? ""}/u/your-personal-link` });
  return {
    ...r,
    revision: ed.revision,
    contentHash: contentHash(ed),
    sender: ctx.sender,
    recipients: ctx.eligibleRecipients,
    defaultSendAt: m.sendAt,
    sendTimePassed: Date.now() > Date.parse(m.sendAt) - 60_000,
    timezone: settings.schedule.timezone,
    report: finalisationReport(ed, ctx),
  };
}
