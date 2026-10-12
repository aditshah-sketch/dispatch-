import "server-only";
import { calendarDetailsKey, type CalendarDraftInput } from "../../client/actions";
import { newId } from "../../domain/edition";
import { fnv1a64 } from "../../domain/text";
import type { CalendarActionView } from "../../views";
import { WORKSPACE_ID } from "../config";
import { iso, json, type Db } from "../db/client";
import { calendarEventId, calendarFreeBusy, calendarGet, calendarInsert, GoogleApiError } from "../providers/google";
import { audit, markHealth } from "../repo/ops";
import { getSettings } from "../repo/settings";
import { googleAccessToken } from "./google-auth";

// Calendar is optional and independent: drafting works without a connection,
// booking needs an explicit "Confirm and book" carrying a hash of exactly the
// details the user reviewed, and newsletter approval never books anything.

type Details = Omit<CalendarActionView, "id" | "kind" | "status" | "storyId" | "eventUrl" | "meetUrl" | "error" | "confirmedAt">;

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function mapRow(r: Record<string, unknown>): CalendarActionView {
  const d = r.details as Details;
  return {
    id: String(r.id), kind: r.kind as CalendarActionView["kind"], status: r.status as CalendarActionView["status"], storyId: (r.story_id as string) ?? null,
    title: d.title, startAt: d.startAt, durationMinutes: d.durationMinutes, timezone: d.timezone, attendees: d.attendees, agenda: d.agenda,
    withMeet: d.withMeet, reminderMinutes: d.reminderMinutes, eventUrl: (r.event_url as string) ?? null, meetUrl: (r.meet_url as string) ?? null,
    error: (r.error as string) ?? null, confirmedAt: iso(r.confirmed_at),
  };
}

export async function listCalendarActions(db: Db, editionId: string): Promise<CalendarActionView[]> {
  const rows = await db.query<Record<string, unknown>>(`select * from calendar_actions where workspace_id = $1 and (edition_id = $2 or edition_id is null) order by created_at desc limit 20`, [WORKSPACE_ID, editionId]);
  return rows.map(mapRow);
}

export async function saveCalendarDraft(db: Db, editionId: string, input: CalendarDraftInput): Promise<{ id: string } | { error: string }> {
  if (!input.title.trim()) return { error: "Add a title." };
  if (Number.isNaN(Date.parse(input.startAt))) return { error: "Choose a valid start time." };
  if (!(input.durationMinutes >= 5 && input.durationMinutes <= 480)) return { error: "Duration must be 5–480 minutes." };
  const attendees = input.kind === "MEETING" ? [...new Set(input.attendees.map((a) => a.trim().toLowerCase()).filter(Boolean))] : [];
  const bad = attendees.filter((a) => !EMAIL.test(a));
  if (bad.length) return { error: `Not a valid email: ${bad.join(", ")}` };
  if (attendees.length > 20) return { error: "At most 20 attendees." };
  const settings = await getSettings(db);
  const details: Details = {
    title: input.title.trim().slice(0, 200), startAt: new Date(input.startAt).toISOString(), durationMinutes: input.durationMinutes,
    timezone: settings.schedule.timezone, attendees, agenda: input.agenda.slice(0, 4000), withMeet: input.kind === "MEETING" && input.withMeet,
    reminderMinutes: Math.max(0, Math.min(1440, input.reminderMinutes)),
  };
  if (input.id) {
    const rows = await db.query(`update calendar_actions set details = $3::jsonb, updated_at = now() where id = $1 and workspace_id = $2 and status = 'DRAFT' returning id`, [input.id, WORKSPACE_ID, json(details)]);
    if (!rows.length) return { error: "This calendar action was already confirmed and can't be edited." };
    return { id: input.id };
  }
  const id = newId("cal");
  await db.query(
    `insert into calendar_actions (id, workspace_id, edition_id, story_id, kind, status, details, external_event_id) values ($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7)`,
    [id, WORKSPACE_ID, editionId, input.storyId ?? null, input.kind, json(details), calendarEventId(id)],
  );
  return { id };
}

export async function deleteCalendarDraft(db: Db, id: string) {
  await db.query(`delete from calendar_actions where id = $1 and workspace_id = $2 and status = 'DRAFT'`, [id, WORKSPACE_ID]);
}

export async function checkAvailability(db: Db, startAt: string, durationMinutes: number) {
  const settings = await getSettings(db);
  const { token } = await googleAccessToken(db, "calendar");
  const end = new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString();
  const busy = await calendarFreeBusy(token, startAt, end, settings.schedule.timezone);
  return { checked: true, conflicts: busy, note: busy.length ? "Conflicts found." : "No conflicts." };
}

export async function bookCalendarAction(db: Db, id: string, detailsHash: string): Promise<{ ok: true; message: string } | { ok: false; code: string; message: string }> {
  const [r] = await db.query<Record<string, unknown>>(`select * from calendar_actions where id = $1 and workspace_id = $2`, [id, WORKSPACE_ID]);
  if (!r) return { ok: false, code: "NOT_FOUND", message: "Calendar draft not found." };
  const view = mapRow(r);
  if (view.status === "CREATED") return { ok: true, message: "Already booked — no duplicate was created." };
  if (fnv1a64(calendarDetailsKey(view)) !== detailsHash) {
    return { ok: false, code: "STALE", message: "The details changed since you reviewed them. Review and confirm again." };
  }
  const eventId = String(r.external_event_id);
  // Record the confirmation before calling Google, so a crash leaves a trace.
  await db.query(`update calendar_actions set status = 'CREATING', confirmed_at = coalesce(confirmed_at, now()), confirmed_details_hash = $2, error = null, updated_at = now() where id = $1`, [id, detailsHash]);
  let token: string;
  try {
    token = (await googleAccessToken(db, "calendar")).token;
  } catch (e) {
    await db.query(`update calendar_actions set status = 'DRAFT', error = $2 where id = $1`, [id, (e as Error).message]);
    return { ok: false, code: "UNAVAILABLE", message: `${(e as Error).message} Your draft is saved.` };
  }
  try {
    const ev = await calendarInsert(token, {
      id: eventId,
      summary: view.title,
      description: view.agenda,
      start: view.startAt,
      end: new Date(Date.parse(view.startAt) + view.durationMinutes * 60_000).toISOString(),
      timeZone: view.timezone,
      attendees: view.attendees,
      reminderMinutes: view.reminderMinutes,
      withMeet: view.withMeet,
    });
    await created(db, id, ev.htmlLink, ev.hangoutLink ?? null);
  } catch (e) {
    const err = e as GoogleApiError;
    if (err.kind === "CONFLICT") {
      // Our deterministic ID already exists: a previous attempt succeeded.
      const ev = await calendarGet(token, eventId).catch(() => null);
      await created(db, id, ev?.htmlLink ?? null, ev?.hangoutLink ?? null);
      return { ok: true, message: "This event already existed from an earlier attempt — no duplicate was created." };
    }
    if (err.kind === "UNKNOWN") {
      const ev = await calendarGet(token, eventId).catch(() => null);
      if (ev) {
        await created(db, id, ev.htmlLink, ev.hangoutLink ?? null);
        return { ok: true, message: "Booked (confirmed after a slow response)." };
      }
      await db.query(`update calendar_actions set status = 'UNKNOWN', error = $2 where id = $1`, [id, "Google didn't respond; retrying is safe and won't create a duplicate."]);
      return { ok: false, code: "UNKNOWN", message: "Google didn't confirm the booking. Retrying is safe — it can't create a duplicate." };
    }
    await db.query(`update calendar_actions set status = 'FAILED', error = $2 where id = $1`, [id, err.message]);
    await markHealth(db, "calendar", false, err.message);
    return { ok: false, code: "FAILED", message: err.message };
  }
  await markHealth(db, "calendar", true);
  await audit(db, { actor: "owner", action: "calendar.created", entityType: "calendar_action", entityId: id, message: `Booked “${view.title}”${view.attendees.length ? ` and invited ${view.attendees.length}` : ""} after explicit confirmation.` });
  return { ok: true, message: view.attendees.length ? `Booked and invitations sent to ${view.attendees.length}.` : "Added to your calendar." };
}

async function created(db: Db, id: string, url: string | null, meet: string | null) {
  // Meet URLs come only from Google's response — never constructed locally.
  await db.query(`update calendar_actions set status = 'CREATED', event_url = $2, meet_url = $3, error = null, updated_at = now() where id = $1`, [id, url, meet]);
}

export { GoogleApiError };
