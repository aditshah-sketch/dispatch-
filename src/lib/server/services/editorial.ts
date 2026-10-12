import "server-only";
import { analyzeArticles, type AnalysisResult } from "../../domain/analysis";
import { approvalIsValid, type Actor, type FinalisationContext } from "../../domain/edition";
import { refsFromPreviousEditions } from "../../domain/history";
import { currentPublishDate, formatInZone, milestonesFor } from "../../domain/schedule";
import type { CommandResult, Edition } from "../../domain/types";
import type { ActionResult } from "../../client/actions";
import type { Db } from "../db/client";
import { articlesSince } from "../repo/articles";
import { ConcurrentUpdateError, coveredRefs, ensureEdition, getEditionById, saveEdition } from "../repo/editions";
import { audit, cancelJobs, enqueue, notify, subscriberCounts } from "../repo/ops";
import { getSettings } from "../repo/settings";
import { getGoogleConnection, hasFeature } from "./google-auth";

export async function currentEdition(db: Db, now = new Date()): Promise<Edition> {
  const settings = await getSettings(db);
  return ensureEdition(db, currentPublishDate(now, settings.schedule));
}

export async function finalisationContext(db: Db): Promise<FinalisationContext & { sender: string | null }> {
  const [settings, counts, google] = await Promise.all([getSettings(db), subscriberCounts(db), getGoogleConnection(db)]);
  const canSend = hasFeature(google, "send");
  return {
    eligibleRecipients: counts.ACTIVE,
    sendingReady: canSend,
    sendingIssue: !google
      ? "Connect Gmail in Settings so the edition can be sent."
      : google.status !== "READY"
        ? `Gmail needs to be reconnected (${google.lastError ?? "access expired"}).`
        : "The connected Google account hasn't granted permission to send email.",
    dailyLimit: settings.sending.dailyLimit,
    sender: google?.accountEmail ?? null,
  };
}

export async function liveAnalysis(db: Db, edition: Edition, now = new Date()): Promise<AnalysisResult> {
  const settings = await getSettings(db);
  const m = milestonesFor(edition.publishDate, settings.schedule);
  const { refs } = refsFromPreviousEditions(await coveredRefs(db), edition.publishDate);
  const articles = await articlesSince(db, m.collectionWindowStart);
  return analyzeArticles(articles, { refs, windowStart: m.collectionWindowStart, edition, now });
}

// Loads the edition, applies a pure command, persists with optimistic
// locking (one retry on a concurrent save), records audit events and runs
// the side effects implied by the state change.
export async function applyCommand(
  db: Db,
  actor: string,
  command: (ed: Edition, at: Actor) => CommandResult | Promise<CommandResult>,
  opts: { editionId?: string } = {},
): Promise<ActionResult<{ edition: Edition }>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ed = opts.editionId ? await getEditionById(db, opts.editionId) : await currentEdition(db);
    if (!ed) return { ok: false, error: { code: "NOT_FOUND", message: "Edition not found." } };
    const result = await command(ed, { actor, now: new Date() });
    if (!result.ok) return { ok: false, error: result.error };
    if (result.edition === ed) return { ok: true, data: { edition: ed } };
    try {
      const saved = await saveEdition(db, ed, result.edition);
      for (const e of result.events) {
        await audit(db, { actor, action: e.action, entityType: "edition", entityId: saved.id, message: e.message, details: e.details });
      }
      await afterChange(db, ed, saved, actor);
      return { ok: true, data: { edition: saved }, message: result.events.map((e) => e.message).join(" ") || undefined };
    } catch (e) {
      if (e instanceof ConcurrentUpdateError && attempt === 0) continue;
      throw e;
    }
  }
  return { ok: false, error: { code: "CONFLICT", message: "The edition was changed at the same time elsewhere. Please try again." } };
}

async function afterChange(db: Db, before: Edition, after: Edition, actor: string) {
  const settings = await getSettings(db);
  // New approval → schedule the send job for exactly that revision.
  if (after.approval && (!before.approval || before.approval.id !== after.approval.id) && approvalIsValid(after)) {
    await enqueue(db, {
      kind: "SEND_CAMPAIGN",
      dedupeKey: `send:${after.id}:${after.approval.revision}`,
      runAt: after.approval.sendAt,
      payload: { editionId: after.id, revision: after.approval.revision, approvalId: after.approval.id },
      maxAttempts: 50, // resumable batches re-enter the job many times
    });
    await notify(db, {
      editionId: after.id,
      kind: "CONFIRMATION",
      channel: "IN_APP",
      status: "SENT",
      revision: after.revision,
      detail: `Revision ${after.revision} confirmed by ${actor}; scheduled for ${formatInZone(after.approval.sendAt, settings.schedule.timezone)}.`,
    });
  }
  // Approval withdrawn (explicitly or by an edit) → invalidate pending delivery.
  if (before.approval && !before.approval.revokedAt && after.approval?.revokedAt) {
    await cancelJobs(db, `send:${after.id}:`);
    await notify(db, {
      editionId: after.id,
      kind: "CONFIRMATION",
      channel: "IN_APP",
      status: "SENT",
      revision: after.revision,
      detail: `Approval for revision ${before.approval.revision} withdrawn: ${after.approval.revokedReason}. The scheduled send was cancelled; confirm again to reschedule.`,
    });
    const { notifyApprovalRevoked } = await import("./telegram-bot");
    await notifyApprovalRevoked(db, after).catch(() => undefined);
  }
}
