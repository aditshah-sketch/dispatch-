import "server-only";
import { newId } from "../../domain/edition";
import { WORKSPACE_ID } from "../config";
import type { Db } from "../db/client";
import { audit } from "../repo/ops";

// Delivery feedback from Resend webhooks (signature verified by the route).
// Only events matched to a delivery this app sent (by Resend email ID) change
// anything. Bounces and complaints stay distinct from reader unsubscribes.

const TEMP_FAILURE_LIMIT = 3;

export interface ResendEvent {
  type: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

export async function processResendEvent(db: Db, eventId: string, ev: ResendEvent): Promise<string> {
  const emailId = ev.data?.email_id;
  const toList = Array.isArray(ev.data?.to) ? ev.data!.to : ev.data?.to ? [ev.data.to] : [];
  // Dedupe on the webhook message ID: redelivered events are no-ops.
  const record = async (kind: string, deliveryId: string | null, detail: string, status: string | null = null) => {
    const rows = await db.query(
      `insert into delivery_feedback (id, workspace_id, provider_message_id, kind, recipient, delivery_id, status_code, detail)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (workspace_id, provider_message_id) do nothing returning id`,
      [newId("fb"), WORKSPACE_ID, `resend:${eventId}`, kind, toList[0]?.toLowerCase() ?? null, deliveryId, status, detail.slice(0, 300)],
    );
    return rows.length > 0;
  };

  const [d] = emailId
    ? await db.query<{ id: string; subscriber_id: string; campaign_id: string; email: string }>(
        `select d.id, d.subscriber_id, d.campaign_id, d.email from deliveries d join campaigns c on c.id = d.campaign_id
         where c.workspace_id = $1 and d.provider_message_id = $2`,
        [WORKSPACE_ID, emailId],
      )
    : [];

  const relevant = ["email.bounced", "email.complained", "email.delivery_delayed", "email.failed", "email.delivered"];
  if (!relevant.includes(ev.type)) return "ignored";
  if (!d) {
    if (ev.type !== "email.delivered") await record("UNMATCHED", null, `${ev.type} for an email this app didn't send; ignored`);
    return "unmatched";
  }

  switch (ev.type) {
    case "email.delivered":
      await db.query(`update deliveries set delivered_at = coalesce(delivered_at, now()) where id = $1`, [d.id]);
      return "delivered";
    case "email.bounced": {
      const type = ev.data?.bounce?.type ?? "Permanent";
      const why = [ev.data?.bounce?.subType, ev.data?.bounce?.message].filter(Boolean).join(": ");
      if (/^permanent$/i.test(type)) {
        if (!(await record("PERMANENT_BOUNCE", d.id, `${type} bounce${why ? ` — ${why}` : ""} — address suppressed`, type))) return "duplicate";
        await db.query(`update subscribers set status = 'BOUNCED', status_reason = $2, updated_at = now() where id = $1 and status = 'ACTIVE'`, [d.subscriber_id, `Permanent bounce (Resend)${why ? `: ${why.slice(0, 160)}` : ""}`]);
        await db.query(`update deliveries set status = 'FAILED_PERMANENT', last_error = $2, updated_at = now() where id = $1`, [d.id, "Bounced after acceptance"]);
        return "permanent";
      }
      return temporary(db, d, () => record("TEMPORARY_BOUNCE", d.id, `${type} bounce${why ? ` — ${why}` : ""} — recorded, not suppressed`, type));
    }
    case "email.delivery_delayed":
      // A delay isn't a failure yet; record it but don't count toward suppression.
      await record("TEMPORARY_BOUNCE", d.id, "Delivery delayed by the receiving server — Resend keeps retrying", "delayed");
      return "delayed";
    case "email.complained":
      if (!(await record("PERMANENT_BOUNCE", d.id, "Recipient marked the email as spam — address suppressed", "complaint"))) return "duplicate";
      await db.query(`update subscribers set status = 'UNSUBSCRIBED', status_reason = 'Marked the newsletter as spam (complaint via Resend)', updated_at = now() where id = $1 and status = 'ACTIVE'`, [d.subscriber_id]);
      await audit(db, { actor: "resend", action: "subscriber.complained", entityType: "subscriber", entityId: d.subscriber_id, message: "A recipient reported the newsletter as spam; they won't be emailed again." });
      return "complaint";
    case "email.failed":
      if (!(await record("PERMANENT_BOUNCE", d.id, "Resend could not send this email after accepting it", "failed"))) return "duplicate";
      await db.query(`update deliveries set status = 'FAILED_PERMANENT', last_error = 'Resend reported the send failed', updated_at = now() where id = $1`, [d.id]);
      return "failed";
  }
  return "ignored";
}

async function temporary(db: Db, d: { id: string; subscriber_id: string; campaign_id: string }, record: () => Promise<boolean>) {
  const prior = await db.query(
    `select 1 from delivery_feedback f join deliveries x on x.id = f.delivery_id where x.campaign_id = $1 and x.subscriber_id = $2 and f.kind = 'TEMPORARY_BOUNCE' and f.status_code <> 'delayed'`,
    [d.campaign_id, d.subscriber_id],
  );
  if (!(await record())) return "duplicate";
  if (!prior.length) {
    const [s] = await db.query<{ temp_failures: number }>(`update subscribers set temp_failures = temp_failures + 1, updated_at = now() where id = $1 returning temp_failures`, [d.subscriber_id]);
    if (s && Number(s.temp_failures) >= TEMP_FAILURE_LIMIT) {
      await db.query(`update subscribers set status = 'BOUNCED', status_reason = $2 where id = $1 and status = 'ACTIVE'`, [d.subscriber_id, `Suppressed after ${TEMP_FAILURE_LIMIT} temporary delivery failures in separate editions`]);
    }
  }
  return "temporary";
}
