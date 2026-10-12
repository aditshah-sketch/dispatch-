import "server-only";
import { approvalIsValid, contentHash, newId } from "../../domain/edition";
import { renderEmail } from "../../domain/email-render";
import type { DeliveryStatus, EditionSnapshot } from "../../domain/types";
import type { CampaignView } from "../../views";
import { config, WORKSPACE_ID } from "../config";
import { signPayload } from "../crypto";
import { iso, json, type Db } from "../db/client";
import { buildMime, GoogleApiError, gmailList, gmailSend } from "../providers/google";
import { getEditionById, getSnapshot, recordPublishedRefs, setEditionStatus } from "../repo/editions";
import { audit, markHealth, notify, rearm, type Job } from "../repo/ops";
import { getSettings } from "../repo/settings";
import { getGoogleConnection, googleAccessToken, hasFeature } from "./google-auth";

// Gmail API per-user quota is 6,000 units/minute and messages.send costs 100
// units, i.e. at most ~60 sends per minute. We pace below that.
const SEND_INTERVAL_MS = Number(process.env.DISPATCH_SEND_INTERVAL_MS ?? 1100);
const BATCH = 10;
const MAX_TEMP_ATTEMPTS = 3;

export function unsubscribeToken(subscriberId: string): string {
  const secret = config.auth().value?.secret;
  if (!secret) throw new Error("AUTH_SECRET is required to create unsubscribe links");
  return signPayload({ s: subscriberId, w: WORKSPACE_ID }, secret);
}

export function unsubscribeUrl(subscriberId: string): string {
  const base = config.baseUrl();
  if (!base) throw new Error("APP_BASE_URL is required to build unsubscribe links");
  return `${base}/u/${unsubscribeToken(subscriberId)}`;
}

export type SendOutcome =
  | { kind: "done"; detail: string }
  | { kind: "continue"; detail: string } // more work now; re-run soon
  | { kind: "defer"; until: string; detail: string } // paused (quota / retry backoff)
  | { kind: "blocked"; detail: string }; // will never send without human action

// The single entry point for sending. Called by the scheduled job and by the
// "run due sends" control; both go through every check below.
export async function runSendJob(db: Db, job: Pick<Job, "payload">, opts: { budgetMs: number }): Promise<SendOutcome> {
  const { editionId, revision, approvalId } = job.payload as { editionId: string; revision: number; approvalId: string };
  const edition = await getEditionById(db, editionId);
  if (!edition) return { kind: "blocked", detail: "Edition no longer exists." };

  let [campaign] = await db.query<Record<string, unknown>>(`select * from campaigns where edition_id = $1 and revision = $2`, [editionId, revision]);

  if (!campaign) {
    // Authorisation gate: only a valid, unrevoked approval of this exact
    // revision, whose frozen snapshot matches the current content, may start a send.
    if (edition.status !== "SCHEDULED" || !approvalIsValid(edition)) {
      await audit(db, { actor: "scheduler", action: "send.blocked", entityType: "edition", entityId: editionId, message: `Send for revision ${revision} blocked: the edition has no valid final approval (status ${edition.status}).` });
      return { kind: "blocked", detail: "No valid final approval — nothing was sent." };
    }
    const a = edition.approval!;
    if (a.id !== approvalId || a.revision !== revision) return { kind: "blocked", detail: "This send job belongs to an older approval." };
    if (Date.now() < Date.parse(a.sendAt) - 30_000) return { kind: "defer", until: a.sendAt, detail: "Not yet time to send." };
    const snap = await getSnapshot(db, editionId, revision);
    if (!snap || snap.contentHash !== a.contentHash || a.contentHash !== contentHash(edition)) {
      await audit(db, { actor: "scheduler", action: "send.blocked", entityType: "edition", entityId: editionId, message: "Send blocked: approved snapshot does not match the current content." });
      return { kind: "blocked", detail: "Approved snapshot doesn't match the content — reconfirmation needed." };
    }
    const google = await getGoogleConnection(db);
    if (!hasFeature(google, "send")) {
      await notify(db, { editionId, kind: "CONFIRMATION", channel: "IN_APP", status: "FAILED", revision, detail: "Scheduled send could not start: Gmail is not connected or needs reconnecting. Nothing was sent. Reconnect, then use “Run due sends”." });
      return { kind: "blocked", detail: "Gmail not connected — nothing was sent." };
    }

    // Start the campaign atomically. Unique (edition, revision) and the
    // one-active-campaign index make duplicate cron invocations harmless.
    const started = await db.tx(async (tx) => {
      const moved = await tx.query(`update editions set status = 'SENDING', lock_version = lock_version + 1, updated_at = now() where id = $1 and status = 'SCHEDULED' returning id`, [editionId]);
      if (!moved.length) return null;
      const id = newId("cmp");
      await tx.query(
        `insert into campaigns (id, workspace_id, edition_id, revision, content_hash, approval_id, status, snapshot) values ($1,$2,$3,$4,$5,$6,'SENDING',$7::jsonb)`,
        [id, WORKSPACE_ID, editionId, revision, a.contentHash, a.id, json(snap.snapshot)],
      );
      await tx.query(
        `insert into deliveries (id, campaign_id, subscriber_id, email, status)
         select 'dlv_' || md5($1 || s.id), $1, s.id, s.email, case when s.status = 'ACTIVE' then 'PENDING' else 'SKIPPED_UNSUBSCRIBED' end
         from subscribers s where s.workspace_id = $2
         on conflict (campaign_id, subscriber_id) do nothing`,
        [id, WORKSPACE_ID],
      );
      return id;
    });
    if (!started) return { kind: "blocked", detail: "Another worker already started this campaign." };
    [campaign] = await db.query(`select * from campaigns where id = $1`, [started]);
    await audit(db, { actor: "scheduler", action: "send.started", entityType: "edition", entityId: editionId, message: `Delivery started for revision ${revision} (approved by ${a.approvedBy} at ${a.approvedAt}).` });
  }

  if (campaign.status !== "SENDING") return { kind: "done", detail: `Campaign already ${campaign.status}.` };
  const campaignId = String(campaign.id);
  if (campaign.paused_until && Date.parse(iso(campaign.paused_until)!) > Date.now()) {
    return { kind: "defer", until: iso(campaign.paused_until)!, detail: `Paused: ${campaign.paused_reason}` };
  }
  await db.query(`update campaigns set paused_until = null, paused_reason = null where id = $1`, [campaignId]);

  // A delivery left in SENDING by a crashed invocation may or may not have
  // been accepted by Gmail. Never resend it automatically.
  await db.query(
    `update deliveries set status = 'UNKNOWN', last_error = 'Interrupted during sending; Gmail may or may not have accepted it', updated_at = now()
     where campaign_id = $1 and status = 'SENDING' and lease_until < now()`,
    [campaignId],
  );

  const snapshot = campaign.snapshot as EditionSnapshot;
  const settings = await getSettings(db);
  const brand = { newsletterName: settings.newsletter.name, fromName: settings.sending.fromName, footer: settings.newsletter.footer };
  const deadline = Date.now() + opts.budgetMs;

  let token: { token: string; email: string | null };
  try {
    token = await googleAccessToken(db, "send");
  } catch (e) {
    return pause(db, campaignId, editionId, revision, 30, (e as Error).message);
  }

  while (Date.now() < deadline) {
    const batch = await db.query<Record<string, unknown>>(
      `update deliveries set status = 'SENDING', attempts = attempts + 1, lease_until = now() + interval '3 minutes', updated_at = now()
       where id in (select id from deliveries where campaign_id = $1 and (status = 'PENDING' or (status = 'FAILED_TEMPORARY' and next_attempt_at <= now() and attempts < $2))
                    order by email limit $3 for update skip locked)
       returning *`,
      [campaignId, MAX_TEMP_ATTEMPTS, BATCH],
    );
    if (!batch.length) break;
    batch.sort((x, y) => String(x.email).localeCompare(String(y.email))); // RETURNING order is unspecified

    for (const d of batch) {
      const id = String(d.id);
      // Suppression is rechecked immediately before each external send.
      const [sub] = await db.query<{ status: string; email: string }>(`select status, email from subscribers where id = $1`, [d.subscriber_id]);
      if (!sub || sub.status !== "ACTIVE") {
        await setDelivery(db, id, "SKIPPED_UNSUBSCRIBED", { error: `Subscriber is ${sub?.status.toLowerCase() ?? "deleted"}` });
        continue;
      }
      if (Date.now() > deadline) {
        await db.query(`update deliveries set status = 'PENDING', attempts = attempts - 1, lease_until = null where id = $1`, [id]);
        continue;
      }
      const email = renderEmail(snapshot, brand, { unsubscribeUrl: unsubscribeUrl(String(d.subscriber_id)) });
      const mime = buildMime({
        fromName: brand.fromName,
        fromEmail: token.email ?? "me",
        to: sub.email,
        replyTo: settings.sending.replyTo || null,
        subject: email.subject,
        html: email.html,
        text: email.text,
        unsubscribeUrl: unsubscribeUrl(String(d.subscriber_id)),
        deliveryRef: id,
      });
      try {
        const sent = await gmailSend(token.token, mime);
        await setDelivery(db, id, "ACCEPTED", { messageId: sent.id, threadId: sent.threadId });
        await markPublished(db, editionId, snapshot);
      } catch (e) {
        const err = e instanceof GoogleApiError ? e : new GoogleApiError((e as Error).message, "UNKNOWN");
        if (err.kind === "UNKNOWN") {
          await setDelivery(db, id, "UNKNOWN", { error: err.message });
        } else if (err.kind === "QUOTA" || err.kind === "AUTH" || err.kind === "REVOKED" || err.kind === "SCOPE") {
          await db.query(`update deliveries set status = 'PENDING', attempts = attempts - 1, lease_until = null where id = $1`, [id]);
          await db.query(`update deliveries set status = 'PENDING', attempts = attempts - 1, lease_until = null where campaign_id = $1 and status = 'SENDING' and id <> $2`, [campaignId, id]);
          if (err.kind !== "QUOTA") await markHealth(db, "gmail", false, err.message);
          return pause(db, campaignId, editionId, revision, err.kind === "QUOTA" ? 60 : 30, err.message);
        } else if (err.kind === "TEMPORARY") {
          const attempts = Number(d.attempts);
          await setDelivery(db, id, "FAILED_TEMPORARY", { error: err.message, retryInSeconds: 120 * 2 ** (attempts - 1) });
        } else {
          await setDelivery(db, id, "FAILED_PERMANENT", { error: err.message });
        }
      }
      await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
    }
  }
  await markHealth(db, "gmail", true);
  return finishIfComplete(db, campaignId, editionId, revision);
}

async function pause(db: Db, campaignId: string, editionId: string, revision: number, minutes: number, reason: string): Promise<SendOutcome> {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await db.query(`update campaigns set paused_until = $2::timestamptz, paused_reason = $3 where id = $1`, [campaignId, until, reason.slice(0, 300)]);
  await notify(db, { editionId, kind: "CONFIRMATION", channel: "IN_APP", status: "FAILED", revision, detail: `Delivery paused: ${reason}. Remaining recipients have not been sent anything; it resumes automatically after ${minutes} minutes.` });
  return { kind: "defer", until, detail: `Paused: ${reason}` };
}

async function setDelivery(db: Db, id: string, status: DeliveryStatus, o: { messageId?: string; threadId?: string; error?: string; retryInSeconds?: number }) {
  await db.query(
    `update deliveries set status = $2, provider_message_id = coalesce($3, provider_message_id), provider_thread_id = coalesce($4, provider_thread_id),
       last_error = $5, lease_until = null, next_attempt_at = case when $6::int is null then null else now() + ($6::int * interval '1 second') end,
       sent_at = case when $2 = 'ACCEPTED' then now() else sent_at end, updated_at = now()
     where id = $1`,
    [id, status, o.messageId ?? null, o.threadId ?? null, o.error?.slice(0, 300) ?? null, o.retryInSeconds ?? null],
  );
}

// An edition joins editorial memory once any recipient's copy was accepted,
// even if the rest of the campaign later fails.
async function markPublished(db: Db, editionId: string, snapshot: EditionSnapshot) {
  const rows = await db.query(`update editions set published_at = now() where id = $1 and published_at is null returning id`, [editionId]);
  if (rows.length) await recordPublishedRefs(db, editionId, snapshot);
}

async function finishIfComplete(db: Db, campaignId: string, editionId: string, revision: number): Promise<SendOutcome> {
  const [c] = await db.query<Record<string, number | string | null>>(
    `select count(*) filter (where status = 'PENDING')::int as pending,
            count(*) filter (where status = 'SENDING')::int as sending,
            count(*) filter (where status = 'FAILED_TEMPORARY' and attempts < $2)::int as retryable,
            min(next_attempt_at) filter (where status = 'FAILED_TEMPORARY' and attempts < $2) as next_retry,
            count(*) filter (where status = 'ACCEPTED')::int as accepted,
            count(*) filter (where status in ('FAILED_PERMANENT','UNKNOWN') or (status = 'FAILED_TEMPORARY' and attempts >= $2))::int as problems,
            count(*)::int as total
     from deliveries where campaign_id = $1`,
    [campaignId, MAX_TEMP_ATTEMPTS],
  );
  if (Number(c.pending) > 0 || Number(c.sending) > 0) return { kind: "continue", detail: `${c.accepted} accepted so far; continuing.` };
  if (Number(c.retryable) > 0) return { kind: "defer", until: iso(c.next_retry) ?? new Date(Date.now() + 120_000).toISOString(), detail: "Waiting to retry temporary failures." };

  const accepted = Number(c.accepted);
  const status = accepted === 0 && Number(c.problems) > 0 ? "FAILED" : Number(c.problems) > 0 ? "PARTIALLY_SENT" : "SENT";
  await db.query(`update campaigns set status = $2, finished_at = now() where id = $1 and status = 'SENDING'`, [campaignId, status]);
  await setEditionStatus(db, editionId, status, { publishedAt: accepted > 0 });
  const detail = `Delivery finished for revision ${revision}: ${accepted} accepted by Gmail, ${c.problems} not delivered or uncertain, of ${c.total} recipients.`;
  await notify(db, { editionId, kind: "CONFIRMATION", channel: "IN_APP", status: status === "FAILED" ? "FAILED" : "SENT", revision, detail });
  await audit(db, { actor: "scheduler", action: `send.${status.toLowerCase()}`, entityType: "edition", entityId: editionId, message: detail });
  return { kind: "done", detail };
}

export async function campaignView(db: Db, editionId: string): Promise<CampaignView | null> {
  const [c] = await db.query<Record<string, unknown>>(`select * from campaigns where edition_id = $1 order by started_at desc limit 1`, [editionId]);
  if (!c) return null;
  const rows = await db.query<{ status: DeliveryStatus; n: number }>(`select status, count(*)::int as n from deliveries where campaign_id = $1 group by status`, [c.id]);
  const counts: CampaignView["counts"] = {};
  let total = 0;
  for (const r of rows) {
    counts[r.status] = Number(r.n);
    total += Number(r.n);
  }
  return {
    id: String(c.id), revision: Number(c.revision), status: String(c.status), startedAt: iso(c.started_at), finishedAt: iso(c.finished_at),
    pausedReason: c.paused_until && Date.parse(iso(c.paused_until)!) > Date.now() ? String(c.paused_reason) : null, counts, total, simulated: false,
  };
}

// Explicit, confirmed resend of UNKNOWN deliveries. If mailbox read access is
// available, first look in Sent mail to reconcile ones that actually went out.
export async function retryUnknown(db: Db, editionId: string): Promise<string> {
  const [c] = await db.query<Record<string, unknown>>(`select * from campaigns where edition_id = $1 order by started_at desc limit 1`, [editionId]);
  if (!c) return "No campaign found.";
  const unknown = await db.query<{ id: string; email: string }>(`select id, email from deliveries where campaign_id = $1 and status = 'UNKNOWN'`, [c.id]);
  if (!unknown.length) return "No uncertain deliveries.";
  let reconciled = 0;
  const google = await getGoogleConnection(db);
  if (hasFeature(google, "feedback")) {
    const { token } = await googleAccessToken(db, "feedback");
    const subject = (c.snapshot as EditionSnapshot).subject.replace(/"/g, "");
    const after = Math.floor(Date.parse(iso(c.started_at)!) / 1000) - 60;
    for (const d of unknown) {
      const found = await gmailList(token, `in:sent to:${d.email} subject:"${subject}" after:${after}`, 1).catch(() => []);
      if (found.length) {
        await setDelivery(db, d.id, "ACCEPTED", { messageId: found[0].id, threadId: found[0].threadId });
        reconciled++;
      }
    }
  }
  const requeue = unknown.length - reconciled;
  if (requeue > 0) {
    await db.query(`update deliveries set status = 'PENDING', last_error = 'Resent after explicit confirmation', updated_at = now() where campaign_id = $1 and status = 'UNKNOWN'`, [c.id]);
    if (c.status !== "SENDING") {
      await db.query(`update campaigns set status = 'SENDING', finished_at = null where id = $1`, [c.id]);
      await setEditionStatus(db, editionId, "SENDING");
    }
    await rearm(db, `send:${editionId}:${c.revision}`);
  }
  await audit(db, { actor: "owner", action: "send.retry_unknown", entityType: "edition", entityId: editionId, message: `Uncertain deliveries: ${reconciled} found in Sent mail, ${requeue} queued for resending after confirmation.` });
  return `${reconciled} confirmed from Sent mail; ${requeue} will be resent.`;
}
