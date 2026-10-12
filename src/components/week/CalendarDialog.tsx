"use client";

import { useMemo, useState } from "react";
import { calendarDetailsKey } from "@/lib/client/actions";
import { useDispatch } from "@/lib/client/context";
import { formatInZone, tzAbbreviation, zonedParts, zonedTimeToUtc } from "@/lib/domain/schedule";
import { fnv1a64 } from "@/lib/domain/text";
import type { EditionStory } from "@/lib/domain/types";
import type { CalendarActionView } from "@/lib/views";
import { Badge, Button, Callout, Dialog, Field, Input, Select, Textarea } from "../ui";

type Kind = CalendarActionView["kind"];

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function toLocalInput(iso: string, tz: string) {
  const p = zonedParts(new Date(iso), tz);
  return { date: p.ymd, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` };
}

export function CalendarDialog({
  kind,
  story,
  existing,
  timezone,
  defaultStart,
  canBook,
  canCheckAvailability,
  onClose,
}: {
  kind: Kind;
  story?: EditionStory | null;
  existing?: CalendarActionView | null;
  timezone: string;
  defaultStart: string;
  canBook: boolean;
  canCheckAvailability: boolean;
  onClose: () => void;
}) {
  const { run, mode } = useDispatch();
  const start = toLocalInput(existing?.startAt ?? defaultStart, timezone);
  const [title, setTitle] = useState(existing?.title ?? (kind === "MEETING" ? (story ? `Follow-up: ${story.headline.slice(0, 80)}` : "") : kind === "REVIEW_BLOCK" ? "Review The Dispatch draft" : "Confirm The Dispatch edition"));
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [duration, setDuration] = useState(existing?.durationMinutes ?? (kind === "DEADLINE_ALERT" ? 15 : 30));
  const [attendees, setAttendees] = useState((existing?.attendees ?? []).join(", "));
  const [agenda, setAgenda] = useState(existing?.agenda ?? "");
  const [withMeet, setWithMeet] = useState(existing?.withMeet ?? false);
  const [reminder, setReminder] = useState(existing?.reminderMinutes ?? 30);
  const [draftId, setDraftId] = useState<string | null>(existing?.id ?? null);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [availability, setAvailability] = useState<{ note: string; conflicts: Array<{ start: string; end: string }>; checked: boolean } | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const tz = tzAbbreviation(timezone);

  const attendeeList = useMemo(() => attendees.split(/[,\s;]+/).map((a) => a.trim()).filter(Boolean), [attendees]);
  const startIso = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? zonedTimeToUtc(date, time, timezone).toISOString() : null;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = "Add a title.";
    if (!startIso) e.start = "Choose a date and time.";
    else if (Date.parse(startIso) < Date.now()) e.start = "That time is in the past.";
    if (!(duration >= 5 && duration <= 480)) e.duration = "Between 5 and 480 minutes.";
    if (kind === "MEETING") {
      const bad = attendeeList.filter((a) => !EMAIL.test(a));
      if (bad.length) e.attendees = `Not a valid email: ${bad.join(", ")}`;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const payload = () => ({
    id: draftId ?? undefined,
    kind,
    storyId: story?.id ?? null,
    title: title.trim(),
    startAt: startIso!,
    durationMinutes: duration,
    attendees: kind === "MEETING" ? attendeeList : [],
    agenda,
    withMeet: kind === "MEETING" && withMeet,
    reminderMinutes: reminder,
  });

  const saveDraft = async () => {
    if (!validate()) return null;
    setBusy("save");
    const r = await run("saveCalendarDraft", payload(), { quiet: true });
    setBusy(null);
    if (!r.ok) {
      setErrors({ form: r.error.message });
      return null;
    }
    setDraftId(r.data.id);
    return r.data.id;
  };

  const review = async () => {
    const id = await saveDraft();
    if (!id) return;
    setStep("review");
    if (canCheckAvailability) {
      setBusy("avail");
      const r = await run("checkAvailability", { startAt: startIso!, durationMinutes: duration }, { quiet: true });
      setBusy(null);
      setAvailability(r.ok ? r.data : { checked: false, conflicts: [], note: r.error.message });
    } else {
      setAvailability({ checked: false, conflicts: [], note: mode === "preview" ? "Preview can't see a real calendar." : "Availability wasn't checked (calendar access not granted)." });
    }
  };

  const book = async () => {
    if (!draftId || !startIso) return;
    const details = { title: title.trim(), startAt: startIso, durationMinutes: duration, attendees: kind === "MEETING" ? attendeeList : [], agenda, withMeet: kind === "MEETING" && withMeet, reminderMinutes: reminder, timezone };
    setBusy("book");
    const r = await run("bookCalendarAction", { id: draftId, confirm: true, detailsHash: fnv1a64(calendarDetailsKey(details)) });
    setBusy(null);
    if (r.ok) onClose();
    else setErrors({ form: r.error.message });
  };

  const suggest = async () => {
    if (!story) return;
    setBusy("suggest");
    const r = await run("suggestMeeting", { storyId: story.id }, { quiet: true });
    setBusy(null);
    if (r.ok) {
      setTitle(r.data.title);
      setAgenda(r.data.agenda);
      setAiNote(r.data.origin === "ai" ? "Suggested by Gemini — edit freely. Attendees are never suggested." : "Template suggestion — edit freely.");
    } else setAiNote(r.error.message);
  };

  const heading = kind === "MEETING" ? "Plan a follow-up meeting" : kind === "REVIEW_BLOCK" ? "Add a review block to your calendar" : "Add a deadline alert";

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={heading}
      description={
        kind === "MEETING"
          ? "Draft the details now. Nothing is booked and nobody is invited until you press “Confirm and book”."
          : "A private event on your own calendar — no guests are added."
      }
      footer={
        step === "edit" ? (
          <>
            {errors.form && <p className="mr-auto text-[13px] text-bad" role="alert">{errors.form}</p>}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button busy={busy === "save"} onClick={async () => { if (await saveDraft()) onClose(); }}>Save draft</Button>
            <Button variant="primary" busy={busy === "save" || busy === "avail"} onClick={review}>Review details</Button>
          </>
        ) : (
          <>
            {errors.form && <p className="mr-auto text-[13px] text-bad" role="alert">{errors.form}</p>}
            <Button variant="ghost" onClick={() => setStep("edit")}>Back to edit</Button>
            <Button variant="primary" busy={busy === "book"} busyLabel="Booking…" disabled={!canBook} onClick={book}>
              {mode === "preview" ? "Confirm and book (simulated)" : kind === "MEETING" && attendeeList.length ? "Confirm, book and invite" : "Confirm and book"}
            </Button>
          </>
        )
      }
    >
      {step === "edit" ? (
        <div className="space-y-4">
          {kind === "MEETING" && story && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-sunk/70 px-3 py-2 text-[13px]">
              <span className="text-ink-2">About: <span className="font-medium text-ink">{story.headline}</span></span>
              <Button size="sm" variant="ghost" busy={busy === "suggest"} onClick={suggest}>Suggest title & agenda</Button>
            </div>
          )}
          {aiNote && <p className="text-[12.5px] text-ink-3">{aiNote}</p>}
          <Field label="Title" htmlFor="cal-title" error={errors.title}>
            <Input id="cal-title" value={title} onChange={(e) => setTitle(e.target.value)} invalid={!!errors.title} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={`Date (${tz})`} htmlFor="cal-date" error={errors.start}>
              <Input id="cal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} invalid={!!errors.start} />
            </Field>
            <Field label={`Start (${tz})`} htmlFor="cal-time">
              <Input id="cal-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="Duration (min)" htmlFor="cal-dur" error={errors.duration}>
              <Input id="cal-dur" type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            </Field>
          </div>
          {kind === "MEETING" && (
            <Field label="Attendees" htmlFor="cal-att" hint="Email addresses, separated by commas. Leave empty to book time only for yourself." error={errors.attendees}>
              <Input id="cal-att" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="name@example.com" invalid={!!errors.attendees} />
            </Field>
          )}
          <Field label={kind === "MEETING" ? "Agenda" : "Notes"} htmlFor="cal-agenda">
            <Textarea id="cal-agenda" rows={4} value={agenda} onChange={(e) => setAgenda(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-6">
            <label className="inline-flex items-center gap-2 text-sm">
              Reminder
              <Select className="h-9 w-auto" value={reminder} onChange={(e) => setReminder(Number(e.target.value))}>
                {[0, 10, 30, 60, 120].map((m) => <option key={m} value={m}>{m === 0 ? "None" : `${m} min before`}</option>)}
              </Select>
            </label>
            {kind === "MEETING" && (
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withMeet} onChange={(e) => setWithMeet(e.target.checked)} className="accent-[var(--color-accent)]" />
                Add a Google Meet link
              </label>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
            <dt className="text-ink-3">Title</dt><dd className="font-medium">{title}</dd>
            <dt className="text-ink-3">When</dt><dd className="font-medium">{formatInZone(startIso, timezone)} · {duration} min</dd>
            <dt className="text-ink-3">Timezone</dt><dd>{timezone}</dd>
            <dt className="text-ink-3">Attendees</dt>
            <dd>{kind === "MEETING" && attendeeList.length ? attendeeList.join(", ") : <span className="text-ink-3">Only you — no invitations sent</span>}</dd>
            {kind === "MEETING" && (<><dt className="text-ink-3">Video</dt><dd>{withMeet ? "Google Meet link will be requested from Google" : "None"}</dd></>)}
            <dt className="text-ink-3">Reminder</dt><dd>{reminder ? `${reminder} minutes before` : "None"}</dd>
            {agenda && (<><dt className="text-ink-3">Agenda</dt><dd className="whitespace-pre-wrap">{agenda}</dd></>)}
          </dl>
          {busy === "avail" ? (
            <p className="text-ink-3">Checking availability…</p>
          ) : availability ? (
            availability.conflicts.length ? (
              <Callout tone="warn" title="You're busy at this time">
                {availability.conflicts.map((c) => `${formatInZone(c.start, timezone, "time")}–${formatInZone(c.end, timezone, "time")}`).join(", ")}. You can still book, or go back and pick another time.
              </Callout>
            ) : (
              <p className={availability.checked ? "text-ok" : "text-ink-3"}>{availability.checked ? "✓ No conflicts on your calendar." : availability.note}</p>
            )
          ) : null}
          {!canBook && (
            <Callout tone="info" title="Google Calendar isn't connected">
              Your draft is saved. Connect Calendar in Settings to book it — the newsletter workflow doesn&apos;t depend on this.
            </Callout>
          )}
          {kind === "MEETING" && attendeeList.length > 0 && <Badge tone="warn">Booking will email invitations to {attendeeList.length} {attendeeList.length === 1 ? "person" : "people"}</Badge>}
        </div>
      )}
    </Dialog>
  );
}
