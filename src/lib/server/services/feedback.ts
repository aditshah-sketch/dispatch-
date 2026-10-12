import "server-only";
import { newId } from "../../domain/edition";
import { WORKSPACE_ID } from "../config";
import type { Db } from "../db/client";
import { parseDsn } from "../dsn";
import { gmailGet, gmailList } from "../providers/google";
import { audit, markHealth } from "../repo/ops";
import { getGoogleConnection, googleAccessToken, hasFeature } from "./google-auth";

// Scheduled incremental mailbox check for bounce notices. Bounces and
// unsubscribes are different events: a bounce never marks someone as
// "unsubscribed", and nothing is suppressed based on arbitrary email text —
// only parsed delivery-status reports matched to a known delivery.

const TEMP_FAILURE_LIMIT = 3;

export async function processFeedback(db: Db): Promise<string> {
  const google = await getGoogleConnection(db);
  if (!hasFeature(google, "feedback")) return "Delivery feedback is not enabled (mailbox read access not granted).";
  const { token } = await googleAccessToken(db, "feedback");
  const list = await gmailList(token, "from:(mailer-daemon OR postmaster) newer_than:14d", 50);
  const seen = new Set(
    (await db.query<{ provider_message_id: string }>(`select provider_message_id from delivery_feedback where workspace_id = $1 and provider_message_id = any($2::text[])`, [WORKSPACE_ID, list.map((m) => m.id)])).map((r) => r.provider_message_id),
  );
  let permanent = 0, temporary = 0, unmatched = 0, unparseable = 0;

  for (const m of list.filter((x) => !seen.has(x.id))) {
    let parsed: ReturnType<typeof parseDsn>;
    try {
      const msg = await gmailGet(token, m.id);
      parsed = parseDsn(msg.payload);
    } catch (e) {
      await record(db, m.id, "UNPARSEABLE", null, null, null, `Could not read: ${(e as Error).message}`);
      unparseable++;
      continue;
    }
    if (!parsed.recipients.length) {
      await record(db, m.id, "UNPARSEABLE", null, null, null, "No delivery-status report found");
      unparseable++;
      continue;
    }
    for (const r of parsed.recipients) {
      // Match: our delivery reference > same Gmail thread > recent accepted delivery to that address.
      const [d] = await db.query<{ id: string; subscriber_id: string; campaign_id: string }>(
        `select d.id, d.subscriber_id, d.campaign_id from deliveries d join campaigns c on c.id = d.campaign_id
         where c.workspace_id = $1 and lower(d.email) = $2
           and (d.id = $3 or d.provider_thread_id = $4 or (d.status = 'ACCEPTED' and d.sent_at > now() - interval '14 days'))
         order by (d.id = $3) desc, (d.provider_thread_id = $4) desc, d.sent_at desc limit 1`,
        [WORKSPACE_ID, r.recipient, parsed.deliveryRef ?? "", m.threadId],
      );
      if (!d || r.kind === "UNKNOWN") {
        await record(db, m.id, d ? "UNPARSEABLE" : "UNMATCHED", r.recipient, d?.id ?? null, r.status, d ? "Status code missing; no action taken" : "No matching delivery from this app; ignored");
        if (d) unparseable++;
        else unmatched++;
        continue;
      }
      if (r.kind === "PERMANENT") {
        await db.query(`update subscribers set status = 'BOUNCED', status_reason = $2, updated_at = now() where id = $1 and status = 'ACTIVE'`, [d.subscriber_id, `Permanent bounce ${r.status}${r.diagnostic ? `: ${r.diagnostic.slice(0, 120)}` : ""}`]);
        await db.query(`update deliveries set status = 'FAILED_PERMANENT', last_error = $2, updated_at = now() where id = $1`, [d.id, `Bounced after acceptance (${r.status})`]);
        await record(db, m.id, "PERMANENT_BOUNCE", r.recipient, d.id, r.status, `${r.status} — address suppressed`);
        permanent++;
      } else {
        // Count at most one temporary failure per campaign per subscriber.
        const prior = await db.query(
          `select 1 from delivery_feedback f join deliveries x on x.id = f.delivery_id where x.campaign_id = $1 and x.subscriber_id = $2 and f.kind = 'TEMPORARY_BOUNCE'`,
          [d.campaign_id, d.subscriber_id],
        );
        if (!prior.length) {
          const [s] = await db.query<{ temp_failures: number }>(`update subscribers set temp_failures = temp_failures + 1, updated_at = now() where id = $1 returning temp_failures`, [d.subscriber_id]);
          if (s && Number(s.temp_failures) >= TEMP_FAILURE_LIMIT) {
            await db.query(`update subscribers set status = 'BOUNCED', status_reason = $2 where id = $1 and status = 'ACTIVE'`, [d.subscriber_id, `Suppressed after ${TEMP_FAILURE_LIMIT} temporary delivery failures in separate editions`]);
          }
        }
        await record(db, m.id, "TEMPORARY_BOUNCE", r.recipient, d.id, r.status, `${r.status ?? "delayed"} — recorded, not suppressed`);
        temporary++;
      }
    }
  }
  await db.query(`update workspace_settings set gmail_history_checked_at = now() where workspace_id = $1`, [WORKSPACE_ID]);
  await markHealth(db, "gmail_feedback", true);
  const summary = `Checked ${list.length} bounce notices: ${permanent} permanent, ${temporary} temporary, ${unmatched} unmatched, ${unparseable} unparseable.`;
  if (permanent + temporary + unmatched + unparseable > 0) await audit(db, { actor: "scheduler", action: "feedback.processed", message: summary });
  return summary;
}

async function record(db: Db, messageId: string, kind: string, recipient: string | null, deliveryId: string | null, status: string | null, detail: string) {
  // Unique per Gmail message: reprocessing the same notice is a no-op.
  await db.query(
    `insert into delivery_feedback (id, workspace_id, provider_message_id, kind, recipient, delivery_id, status_code, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (workspace_id, provider_message_id) do nothing`,
    [newId("fb"), WORKSPACE_ID, messageId, kind, recipient, deliveryId, status, detail],
  );
}
