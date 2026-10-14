import "server-only";
import { currentPublishDate, milestonesFor } from "../../domain/schedule";
import { config, WORKSPACE_ID } from "../config";
import type { Db } from "../db/client";
import { ensureEdition } from "../repo/editions";
import { audit, claim, deferJob, enqueue, failJob, finishJob, notify, setJobStage, type Job } from "../repo/ops";
import { getSettings } from "../repo/settings";
import { runSendJob } from "./delivery";
import { generateDraft } from "./drafting";
import { processFeedback } from "./feedback";
import { getGoogleConnection, hasFeature } from "./google-auth";
import { runIngestion } from "./ingestion";
import { sendDraft, sendReminder } from "./telegram-bot";

// The scheduler is stateless: every tick (Vercel Cron, an external scheduler,
// or a "Run now" control) recomputes what is due for this edition in the
// workspace timezone and enqueues it under a deterministic dedupe key. Jobs are
// then claimed with leases, so overlapping or duplicate ticks are harmless.

export async function ensureScheduledJobs(db: Db, now = new Date()): Promise<string[]> {
  const settings = await getSettings(db);
  const publishDate = currentPublishDate(now, settings.schedule);
  const m = milestonesFor(publishDate, settings.schedule);
  const edition = await ensureEdition(db, publishDate);
  const created: string[] = [];
  const t = now.getTime();
  const add = async (kind: Job["kind"], key: string, runAt: string, payload: Record<string, unknown> = {}) => {
    const r = await enqueue(db, { kind, dedupeKey: key, runAt, payload });
    if (r.created) created.push(key);
  };

  for (const run of m.collectRuns) {
    // Only recent collection slots; a missed slot from days ago isn't replayed.
    if (Date.parse(run) <= t && t - Date.parse(run) < 20 * 3_600_000 && t < Date.parse(m.sendAt)) await add("COLLECT", `collect:${publishDate}:${run}`, run);
  }
  if (Date.parse(m.draftAt) <= t && t < Date.parse(m.sendAt)) await add("GENERATE_DRAFT", `draft:${publishDate}`, m.draftAt, { editionId: edition.id });
  if (Date.parse(m.draftDeliveryAt) <= t && t < Date.parse(m.sendAt)) await add("DELIVER_DRAFT", `deliver:${publishDate}`, m.draftDeliveryAt, { editionId: edition.id });
  if (Date.parse(m.reminderAt) <= t && t < Date.parse(m.sendAt)) await add("REMINDER", `reminder:${publishDate}`, m.reminderAt, { editionId: edition.id });
  if (hasFeature(await getGoogleConnection(db), "feedback")) {
    await add("PROCESS_FEEDBACK", `feedback:${new Date(t).toISOString().slice(0, 13)}`, now.toISOString());
  }
  return created;
}

// Editions past review (confirmed, sending or sent) need no draft, no draft
// delivery and no reminder; scheduled steps for them finish as skipped.
const PAST_REVIEW = ["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED"];

export async function runJob(db: Db, job: Job, budgetMs: number): Promise<{ detail: string; more: boolean }> {
  const stage = (s: string) => setJobStage(db, job.id, s);
  try {
    if (job.kind === "GENERATE_DRAFT" || job.kind === "DELIVER_DRAFT") {
      const settings = await getSettings(db);
      const ed = await ensureEdition(db, currentPublishDate(new Date(), settings.schedule));
      if (PAST_REVIEW.includes(ed.status)) {
        const detail = `Skipped: this week's edition is already ${ed.status.toLowerCase().replace("_", " ")}.`;
        await finishJob(db, job.id, { skipped: detail });
        return { detail, more: false };
      }
    }
    switch (job.kind) {
      case "COLLECT": {
        const r = await runIngestion(db, { trigger: job.dedupeKey.startsWith("collect:manual") ? "manual" : "schedule", onStage: stage });
        await finishJob(db, job.id, { summary: r.summary });
        return { detail: r.summary, more: false };
      }
      case "GENERATE_DRAFT": {
        const manual = job.dedupeKey.startsWith("draft:manual");
        if (!config.gemini().ok) {
          const edId = job.payload.editionId as string | undefined;
          await notify(db, { editionId: edId ?? null, kind: "DRAFT_DELIVERY", channel: "IN_APP", status: "SKIPPED", detail: "The draft wasn't generated automatically because Gemini isn't configured. Pick stories from the Articles page." });
          await finishJob(db, job.id, { skipped: "gemini not configured" });
          return { detail: "Gemini not configured — skipped.", more: false };
        }
        const r = await generateDraft(db, { actor: manual ? "owner" : "scheduler", replace: !!job.payload.replace, onStage: stage });
        if (!r.ok && !manual && /already exists/.test(r.message)) {
          await finishJob(db, job.id, { skipped: r.message });
          return { detail: r.message, more: false };
        }
        if (r.ok) await finishJob(db, job.id, { message: r.message });
        else await failJob(db, job, r.message, { retryable: !manual && /temporarily|quota|reach|in time/i.test(r.message) });
        return { detail: r.message, more: false };
      }
      case "DELIVER_DRAFT": {
        const r = await sendDraft(db, "scheduler");
        if (r.ok || /no draft|isn't configured|No Telegram chat/i.test(r.message)) await finishJob(db, job.id, { message: r.message });
        else await failJob(db, job, r.message, { retryable: true });
        return { detail: r.message, more: false };
      }
      case "REMINDER": {
        const msg = await sendReminder(db);
        await finishJob(db, job.id, { message: msg });
        await audit(db, { actor: "scheduler", action: "reminder.ran", message: msg });
        return { detail: msg, more: false };
      }
      case "SEND_CAMPAIGN": {
        const out = await runSendJob(db, job, { budgetMs });
        if (out.kind === "done" || out.kind === "blocked") await finishJob(db, job.id, { outcome: out.kind, detail: out.detail });
        else await deferJob(db, job.id, out.kind === "continue" ? new Date().toISOString() : out.until, out.detail);
        return { detail: out.detail, more: out.kind === "continue" };
      }
      case "PROCESS_FEEDBACK": {
        const msg = await processFeedback(db);
        await finishJob(db, job.id, { message: msg });
        return { detail: msg, more: false };
      }
    }
  } catch (e) {
    await failJob(db, job, (e as Error).message, { retryable: true });
    return { detail: (e as Error).message, more: false };
  }
  await finishJob(db, job.id);
  return { detail: "Done", more: false };
}

export async function tick(db: Db, opts: { budgetMs: number; now?: Date }): Promise<{ created: string[]; ran: Array<{ kind: string; detail: string }>; more: boolean }> {
  const started = Date.now();
  const created = await ensureScheduledJobs(db, opts.now);
  const ran: Array<{ kind: string; detail: string }> = [];
  let more = false;
  while (Date.now() - started < opts.budgetMs - 15_000) {
    const job = await claim(db);
    if (!job) break;
    const r = await runJob(db, job, Math.max(10_000, opts.budgetMs - (Date.now() - started) - 20_000));
    ran.push({ kind: job.kind, detail: r.detail });
    more ||= r.more;
  }
  if (!more) {
    const [due] = await db.query(`select 1 from jobs where workspace_id = $1 and status = 'QUEUED' and run_at <= now() limit 1`, [WORKSPACE_ID]);
    more = !!due;
  }
  return { created, ran, more };
}

// Runs a specific job right away (manual "Run now"), sharing the same code path.
export async function runJobNow(db: Db, jobId: string, budgetMs: number) {
  const job = await claim(db, { id: jobId });
  if (!job) return null;
  return runJob(db, job, budgetMs);
}
