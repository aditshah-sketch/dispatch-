"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { topicSummary } from "@/lib/domain/edition";
import { formatInZone, formatYmd, tzAbbreviation } from "@/lib/domain/schedule";
import { MAX_STORIES, MIN_STORIES, MIN_TOPICS } from "@/lib/domain/selection";
import type { EditionStory } from "@/lib/domain/types";
import type { CalendarActionView, CampaignView, WeekView } from "@/lib/views";
import { Badge, Button, Callout, Card, Disclosure, ErrorPanel, Input, LoadingBlock, PageHeader, SectionTitle, Stat, Textarea } from "../ui";
import { CalendarDialog } from "./CalendarDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { StoryCard } from "./StoryCard";
import { SwapDialog } from "./SwapDialog";

export function WeekScreen() {
  const { refresh } = useDispatch();
  const { data, error, loading } = useView((c) => c.week());

  // Poll while a background job (collection / draft generation) is running.
  const running = data?.job && (data.job.status === "QUEUED" || data.job.status === "RUNNING");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [running, refresh]);

  if (!data) return loading ? <LoadingBlock label="Loading this week's edition…" /> : <ErrorPanel message={error ?? "Unknown error"} onRetry={refresh} />;
  return <Week view={data} />;
}

function Week({ view }: { view: WeekView }) {
  const { run, base, mode } = useDispatch();
  const [swap, setSwap] = useState<EditionStory | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [calendar, setCalendar] = useState<{ kind: CalendarActionView["kind"]; story?: EditionStory | null; existing?: CalendarActionView | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ed = view.edition;
  const tz = view.timezone;
  const stories = [...(ed?.stories ?? [])].sort((a, b) => a.position - b.position);
  const frozen = !!ed && ["SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED"].includes(ed.status);
  const topics = topicSummary(stories).filter((t) => t.topic !== "other");

  const primary = async () => {
    const kind = view.stage.primary.kind;
    if (kind === "collect") {
      setBusy("primary");
      await run("collect", {});
      setBusy(null);
    } else if (kind === "generate") {
      setBusy("primary");
      await run("generateDraft", {});
      setBusy(null);
    } else if (kind === "review") {
      const first = stories.find((s) => !s.commentary.trim()) ?? stories.find((s) => s.reviewStatus !== "APPROVED") ?? stories[0];
      document.getElementById(first ? `story-${first.id}` : "stories")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (kind === "confirm") setConfirmOpen(true);
    else if (kind === "view_delivery") document.getElementById("delivery")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={`This week${ed?.issueNumber ? ` · Issue ${ed.issueNumber}` : ""}`}
        title={formatYmd(view.milestones.publishDate)}
      >
        Publication target <span className="font-medium text-ink">{formatInZone(view.milestones.sendAt, tz)}</span>
        <span className="text-ink-3"> · all times {tzAbbreviation(tz)} ({tz})</span>
      </PageHeader>

      {/* Stage + next action */}
      <Card className="overflow-hidden">
        <ol className="grid grid-cols-4 border-b border-rule" aria-label="Workflow stage">
          {view.stage.steps.map((s, i) => (
            <li
              key={s.label}
              aria-current={s.state === "current" ? "step" : undefined}
              className={clsx(
                "relative px-2 py-3 text-center text-[12.5px] font-medium sm:text-[13px]",
                s.state === "done" && "text-ok",
                s.state === "current" && "bg-accent-soft/60 text-accent-strong",
                s.state === "blocked" && "bg-bad-soft text-bad",
                s.state === "upcoming" && "text-ink-3",
                i > 0 && "border-l border-rule",
              )}
            >
              <span aria-hidden>{s.state === "done" ? "✓ " : `${i + 1}. `}</span>
              {s.label}
              <span className="sr-only"> — {s.state}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div className="min-w-0">
            <p className="font-serif text-[24px] font-semibold leading-snug">{view.stage.headline}</p>
            <p className="mt-1.5 max-w-xl text-[14.5px] text-ink-2">{view.stage.detail}</p>
            {view.job && (view.job.status === "RUNNING" || view.job.status === "QUEUED") && (
              <p className="mt-2 inline-flex items-center gap-2 text-[13px] text-ink-2" role="status">
                <span className="inline-block size-3 rounded-full border-2 border-accent border-r-transparent [animation:spin_.8s_linear_infinite]" />
                {view.job.stage ?? "Starting…"}
              </p>
            )}
            {view.job?.status === "FAILED" && <p className="mt-2 text-[13px] text-bad">Last run failed: {view.job.error}</p>}
          </div>
          {view.stage.primary.kind !== "none" && (
            <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
              {view.stage.primary.kind === "start_manual" ? (
                <Link href={`${base}/articles`} className="inline-flex h-12 items-center rounded-md bg-accent px-6 text-[15px] font-medium text-white hover:bg-accent-strong">
                  {view.stage.primary.label}
                </Link>
              ) : (
                <Button variant="primary" size="lg" busy={busy === "primary"} onClick={primary}>
                  {view.stage.primary.label}
                </Button>
              )}
              {view.stage.primary.hint && <span className="max-w-[240px] text-[12px] text-ink-3 sm:text-right">{view.stage.primary.hint}</span>}
            </div>
          )}
        </div>
      </Card>

      {/* Key facts */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4">
        <Stat
          label="Stories"
          value={ed?.stories.length ? `${ed.stories.length}` : "—"}
          tone={ed && ed.stories.length > 0 && (ed.stories.length < MIN_STORIES || ed.stories.length > MAX_STORIES) ? "warn" : undefined}
          sub={`Target ${MIN_STORIES}–${MAX_STORIES}`}
        />
        <Stat
          label="Topics"
          value={stories.length ? topics.length : "—"}
          tone={stories.length > 0 && topics.length < MIN_TOPICS ? "warn" : undefined}
          sub={topics.length ? topics.map((t) => t.label).join(" · ") : `At least ${MIN_TOPICS} needed`}
        />
        <Stat
          label={view.collection.isSample ? "Collected (sample)" : "Collected"}
          value={view.collection.total}
          sub={
            <>
              {view.collection.eligible} eligible · {view.collection.duplicates} duplicates · {view.collection.sameEvent} same-event · {view.collection.covered} already covered
            </>
          }
        />
        <Stat label="History check" value={`${view.history.checked}/${view.history.depth}`} tone={view.history.checked < view.history.depth ? "warn" : undefined} sub={view.history.label} />
      </div>

      {/* Attention */}
      {(view.attention.length > 0 || (view.finalisation?.blockers.length ?? 0) > 0) && (
        <section aria-labelledby="attention">
          <SectionTitle id="attention">Needs your attention</SectionTitle>
          <div className="space-y-2">
            {view.finalisation?.blockers.map((b) => (
              <Callout key={b} tone="bad">{b}</Callout>
            ))}
            {view.attention.map((a) => (
              <Callout key={a.id} tone={a.tone === "error" ? "bad" : a.tone === "warn" ? "warn" : "info"} title={a.title} action={a.href ? <Link className="text-[13px] font-medium text-accent underline-offset-4 hover:underline" href={a.href.startsWith("/") ? a.href : `${base}${a.href}`}>Open</Link> : undefined}>
                {a.detail}
              </Callout>
            ))}
          </div>
        </section>
      )}

      {/* Draft */}
      {ed && stories.length > 0 && (
        <section aria-labelledby="stories" className="scroll-mt-6">
          <SectionTitle
            id="stories"
            sub={
              <>
                Revision {ed.revision} · {stories.filter((s) => s.reviewStatus === "APPROVED").length} of {stories.length} reviewed
                {ed.generatedBy === "ai" && " · drafted by Gemini"}
                {ed.generatedBy === "sample" && " · sample draft"}
                {ed.generatedBy === "manual" && " · built by you"}
              </>
            }
            action={
              !frozen && (
                <Button variant={view.stage.primary.kind === "confirm" ? "secondary" : "secondary"} onClick={() => setConfirmOpen(true)}>
                  Preview email
                </Button>
              )
            }
          >
            The draft
          </SectionTitle>

          {ed.draftNotes.length > 0 && (
            <div className="mb-4 space-y-2">
              {ed.draftNotes.map((n) => <Callout key={n} tone={/incomplete|only|fewer|could not|failed/i.test(n) ? "warn" : "info"}>{n}</Callout>)}
            </div>
          )}

          <Framing key={`${ed.id}-${ed.revision}`} edition={ed} frozen={frozen} />

          <div className="mt-5 space-y-4">
            {stories.map((s, i) => (
              <StoryCard
                key={s.id}
                story={s}
                editionId={ed.id}
                timezone={tz}
                frozen={frozen}
                canRegenerate={view.capabilities.ai}
                isFirst={i === 0}
                isLast={i === stories.length - 1}
                onSwap={() => setSwap(s)}
                onFollowUp={() => setCalendar({ kind: "MEETING", story: s })}
              />
            ))}
          </div>

          {!frozen && stories.length < MAX_STORIES && (
            <p className="mt-4 text-sm text-ink-2">
              Room for {MAX_STORIES - stories.length} more. <Link href={`${base}/articles`} className="font-medium text-accent underline-offset-4 hover:underline">Add from articles</Link>
            </p>
          )}
        </section>
      )}

      {ed && ["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT", "FAILED"].includes(ed.status) && (
        <DeliveryPanel view={view} />
      )}

      <ReviewChannel view={view} />

      {/* Calendar (optional) */}
      <section aria-labelledby="cal">
        <SectionTitle id="cal" sub="Optional. The newsletter never depends on your calendar.">Calendar & follow-ups</SectionTitle>
        <Card className="divide-y divide-rule">
          {view.calendarActions.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">{c.title}</p>
                <p className="text-[13px] text-ink-3">
                  {c.kind === "MEETING" ? "Meeting" : c.kind === "REVIEW_BLOCK" ? "Review block" : "Deadline alert"} · {formatInZone(c.startAt, tz)} · {c.durationMinutes} min
                  {c.attendees.length > 0 && ` · ${c.attendees.length} invitee${c.attendees.length > 1 ? "s" : ""}`}
                </p>
                {c.error && <p className="text-[13px] text-bad">{c.error}</p>}
                {c.meetUrl && <a className="text-[13px] text-accent underline" href={c.meetUrl} target="_blank" rel="noreferrer">Google Meet link</a>}
              </div>
              <div className="flex items-center gap-2">
                <CalendarStatus status={c.status} />
                {c.status === "DRAFT" && (
                  <>
                    <Button size="sm" onClick={() => setCalendar({ kind: c.kind, story: stories.find((s) => s.id === c.storyId) ?? null, existing: c })}>Review & book</Button>
                    <Button size="sm" variant="ghost" onClick={() => run("deleteCalendarDraft", { id: c.id }, { quiet: true })}>Discard</Button>
                  </>
                )}
                {c.eventUrl && <a className="text-[13px] font-medium text-accent underline-offset-4 hover:underline" href={c.eventUrl} target="_blank" rel="noreferrer">Open event</a>}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <Button size="sm" variant="ghost" onClick={() => setCalendar({ kind: "REVIEW_BLOCK" })}>+ Review block</Button>
            <Button size="sm" variant="ghost" onClick={() => setCalendar({ kind: "DEADLINE_ALERT" })}>+ Deadline alert</Button>
            <span className="text-[12.5px] text-ink-3">Follow-up meetings start from a story&apos;s “More” menu.</span>
          </div>
        </Card>
      </section>

      <DemoControls view={view} />

      <Disclosure summary={`Activity log (${view.activity.length})`}>
        <ol className="space-y-1.5 border-l border-rule pl-4 text-[13px]">
          {view.activity.slice(0, 40).map((a) => (
            <li key={a.id}>
              <span className="text-ink-3">{formatInZone(a.at, tz, "short")} · {a.actor}</span> — {a.message}
            </li>
          ))}
        </ol>
      </Disclosure>

      {swap && <SwapDialog story={swap} onClose={() => setSwap(null)} />}
      {confirmOpen && <ConfirmDialog onClose={() => setConfirmOpen(false)} />}
      {calendar && (
        <CalendarDialog
          kind={calendar.kind}
          story={calendar.story}
          existing={calendar.existing}
          timezone={tz}
          defaultStart={calendar.kind === "DEADLINE_ALERT" ? view.milestones.reminderAt : view.milestones.draftDeliveryAt}
          canBook={view.capabilities.calendar}
          canCheckAvailability={view.capabilities.calendarAvailability}
          onClose={() => setCalendar(null)}
        />
      )}
      {mode === "preview" && <p className="text-center text-[12px] text-ink-3">Preview data lives only in this browser.</p>}
    </div>
  );
}

function Framing({ edition, frozen }: { edition: NonNullable<WeekView["edition"]>; frozen: boolean }) {
  const { run } = useDispatch();
  const [subject, setSubject] = useState(edition.subject);
  const [intro, setIntro] = useState(edition.intro);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = subject !== edition.subject || intro !== edition.intro;

  return (
    <Card className="p-5">
      <div className="grid gap-4">
        <div>
          <label htmlFor="subject" className="mb-1.5 block text-[13px] font-medium">Subject line</label>
          <Input id="subject" value={subject} disabled={frozen} onChange={(e) => setSubject(e.target.value)} placeholder="The Dispatch: …" invalid={!subject.trim()} />
        </div>
        <div>
          <label htmlFor="intro" className="mb-1.5 block text-[13px] font-medium">Introduction <span className="font-normal text-ink-3">(optional)</span></label>
          <Textarea id="intro" autoGrow rows={2} value={intro} disabled={frozen} onChange={(e) => setIntro(e.target.value)} className="font-serif text-[16px]" />
        </div>
        {!frozen && (
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={!dirty}
              busy={state === "saving"}
              onClick={async () => {
                setState("saving");
                const r = await run("editFraming", { subject, intro, baseRevision: edition.revision }, { quiet: true });
                setState(r.ok ? "saved" : "error");
                setMsg(r.ok ? null : r.error.message);
              }}
            >
              Save subject & intro
            </Button>
            <span role="status" className={clsx("text-[12px]", state === "error" ? "text-bad" : "text-ink-3")}>
              {dirty ? "Unsaved changes" : state === "saved" ? "Saved" : ""}
              {msg}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

const DELIVERY_LABEL: Record<string, string> = {
  ACCEPTED: "Accepted by provider",
  PENDING: "Waiting to send",
  SENDING: "Sending",
  FAILED_TEMPORARY: "Temporary failure (will retry)",
  FAILED_PERMANENT: "Permanent failure",
  UNKNOWN: "Uncertain — needs checking",
  SKIPPED_UNSUBSCRIBED: "Skipped (unsubscribed / bounced)",
};

function DeliveryPanel({ view }: { view: WeekView }) {
  const { run } = useDispatch();
  const ed = view.edition!;
  const c: CampaignView | null = view.campaign;
  return (
    <section id="delivery" aria-labelledby="delivery-h" className="scroll-mt-6">
      <SectionTitle id="delivery-h">Delivery</SectionTitle>
      <Card className="p-5 sm:p-6">
        {ed.status === "SCHEDULED" && ed.approval && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Revision {ed.approval.revision} approved {formatInZone(ed.approval.approvedAt, view.timezone, "short")} via {ed.approval.channel}</p>
              <p className="text-sm text-ink-2">
                Sends {ed.approval.sendNow ? "as soon as the next delivery run starts" : formatInZone(ed.approval.sendAt, view.timezone)} to {ed.approval.recipientCount.toLocaleString("en-IN")} recipients from {ed.approval.sender ?? "—"}.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => run("revokeApproval", { reason: "Withdrawn by editor before sending" })}>Withdraw approval</Button>
          </div>
        )}
        {c ? (
          <div className={ed.status === "SCHEDULED" ? "mt-5" : ""}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone={c.status === "SENT" ? "ok" : c.status === "FAILED" ? "bad" : c.status === "PARTIALLY_SENT" ? "warn" : "info"}>{c.status.replace("_", " ")}</Badge>
              {c.simulated && <Badge tone="warn">Simulated — no email sent</Badge>}
              {c.pausedReason && <Badge tone="warn">Paused: {c.pausedReason}</Badge>}
              <span className="text-[13px] text-ink-3">{c.total} recipients in this campaign · revision {c.revision}</span>
            </div>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              {Object.entries(DELIVERY_LABEL).map(([k, label]) =>
                (c.counts as Record<string, number>)[k] ? (
                  <div key={k} className="flex justify-between border-b border-rule/70 py-1">
                    <dt className="text-ink-2">{c.simulated && k === "ACCEPTED" ? "Would be sent (simulated)" : label}</dt>
                    <dd className="font-medium tabular-nums">{(c.counts as Record<string, number>)[k]}</dd>
                  </div>
                ) : null,
              )}
            </dl>
            <p className="mt-3 text-[12.5px] text-ink-3">“Accepted” means the email provider took the message. It does not prove inbox delivery or that anyone opened it.</p>
            {(c.counts.UNKNOWN ?? 0) > 0 && !c.simulated && (
              <Callout tone="warn" title={`${c.counts.UNKNOWN} uncertain deliveries`} action={<Button size="sm" onClick={() => run("retryUnknownDeliveries", { confirm: true })}>Resend uncertain</Button>}>
                The provider may or may not have accepted these (e.g. a timeout). They are not retried automatically, to avoid duplicates. Resending may deliver a second copy.
              </Callout>
            )}
          </div>
        ) : (
          ed.status !== "SCHEDULED" && <p className="text-sm text-ink-3">No delivery has started.</p>
        )}
      </Card>
    </section>
  );
}

function ReviewChannel({ view }: { view: WeekView }) {
  const { run, base } = useDispatch();
  const [busy, setBusy] = useState(false);
  const hasDraft = !!view.edition?.stories.length;
  return (
    <section aria-labelledby="channel">
      <SectionTitle id="channel" sub={`Draft goes to Telegram ${formatInZone(view.milestones.draftDeliveryAt, view.timezone)}; reminder ${formatInZone(view.milestones.reminderAt, view.timezone, "time")} Wednesday if not confirmed.`}>
        Telegram review
      </SectionTitle>
      <Card className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-2">
            {view.capabilities.telegram
              ? "Approve, edit and swap stories from Telegram. Final confirmation there always shows the exact revision first."
              : <>Telegram isn&apos;t connected, so drafts and reminders appear here instead. <Link className="font-medium text-accent underline-offset-4 hover:underline" href={`${base}/settings`}>Connect Telegram</Link></>}
          </p>
          <Button size="sm" disabled={!hasDraft || !view.capabilities.telegram} busy={busy} onClick={async () => { setBusy(true); await run("sendDraftToTelegram", {}); setBusy(false); }}>
            Send draft to Telegram
          </Button>
        </div>
        {view.notifications.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t border-rule pt-4 text-[13px]">
            {view.notifications.slice(0, 6).map((n) => (
              <li key={n.id} className="flex gap-2">
                <Badge tone={n.status === "SENT" ? "ok" : n.status === "FAILED" ? "bad" : n.status === "SIMULATED" ? "warn" : "neutral"}>
                  {n.status === "SIMULATED" ? "Simulated" : n.status === "SENT" ? "Sent" : n.status === "FAILED" ? "Failed" : "Skipped"}
                </Badge>
                <span className="text-ink-2">
                  <span className="text-ink-3">{formatInZone(n.at, view.timezone, "short")} · </span>
                  {n.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function CalendarStatus({ status }: { status: CalendarActionView["status"] }) {
  const map: Record<CalendarActionView["status"], [string, "neutral" | "ok" | "warn" | "bad" | "info"]> = {
    DRAFT: ["Draft — not booked", "neutral"],
    CREATING: ["Booking…", "info"],
    CREATED: ["Booked", "ok"],
    FAILED: ["Failed", "bad"],
    UNKNOWN: ["Uncertain — checking", "warn"],
    SIMULATED: ["Simulated", "warn"],
  };
  const [label, tone] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

function DemoControls({ view }: { view: WeekView }) {
  const { run, mode } = useDispatch();
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (task: "draft_delivery" | "reminder" | "send_due" | "feedback" | "process_jobs") => {
    setBusy(task);
    await run("runScheduledNow", { task });
    setBusy(null);
  };
  return (
    <Disclosure summary="Run a scheduled step now">
      <Card className="p-5">
        <p className="mb-3 text-[13px] text-ink-2">
          These buttons call the same services the scheduler runs, so you can demonstrate the week on any day. They never bypass final approval:
          the send step only delivers an edition that has a valid approval for its current revision.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" busy={busy === "draft_delivery"} onClick={() => go("draft_delivery")}>Wed 6 PM · deliver draft</Button>
          <Button size="sm" busy={busy === "reminder"} onClick={() => go("reminder")}>Wed 10 PM · approval reminder</Button>
          <Button size="sm" busy={busy === "send_due"} onClick={() => go("send_due")}>{mode === "preview" ? "Thu 9 AM · simulate delivery" : "Thu 9 AM · run due sends"}</Button>
          {mode === "live" && <Button size="sm" busy={busy === "feedback"} onClick={() => go("feedback")}>Check bounce feedback</Button>}
          {mode === "live" && <Button size="sm" busy={busy === "process_jobs"} onClick={() => go("process_jobs")}>Process due jobs</Button>}
        </div>
        {view.edition?.status === "IN_REVIEW" && (
          <p className="mt-3 text-[12.5px] text-ink-3">Try the send step now: it will refuse, because the edition isn&apos;t confirmed.</p>
        )}
      </Card>
    </Disclosure>
  );
}
