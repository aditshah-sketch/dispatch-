"use client";

import { useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { formatInZone, isValidHHMM, WEEKDAYS, type ScheduleConfig } from "@/lib/domain/schedule";
import { STYLE_GUIDE_LABEL } from "@/lib/domain/style-guide";
import type { IntegrationStatus, SettingsView } from "@/lib/views";
import { Badge, Button, Callout, Card, Disclosure, ErrorPanel, Field, Input, LoadingBlock, PageHeader, SectionTitle, Select, Textarea, type Tone } from "../ui";

export function SettingsScreen() {
  const { refresh } = useDispatch();
  const { data, error, loading } = useView((c) => c.settings());
  if (!data) return loading ? <LoadingBlock label="Loading settings…" /> : <ErrorPanel message={error ?? ""} onRetry={refresh} />;
  return <Settings view={data} />;
}

const STATE: Record<IntegrationStatus["state"], { label: string; tone: Tone }> = {
  READY: { label: "Ready", tone: "ok" },
  NOT_CONNECTED: { label: "Not connected", tone: "neutral" },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "warn" },
  UNAVAILABLE: { label: "Unavailable", tone: "bad" },
  SIMULATED: { label: "Simulated in preview", tone: "warn" },
};

const GOOGLE_FEATURE: Partial<Record<IntegrationStatus["key"], string>> = { gmail: "send", gmail_feedback: "feedback", calendar: "calendar" };

function Settings({ view }: { view: SettingsView }) {
  const core = view.integrations.filter((i) => !i.optional);
  const optional = view.integrations.filter((i) => i.optional);
  return (
    <div className="space-y-12">
      <PageHeader eyebrow="Settings" title="Connections & preferences">
        {view.mode === "preview"
          ? "In preview every integration is simulated. Connected mode activates each one independently as its credentials are added."
          : "Each integration works on its own — a missing one only disables the step that needs it."}
      </PageHeader>

      <section aria-labelledby="int-h">
        <SectionTitle id="int-h">Integrations</SectionTitle>
        <div className="grid gap-3 md:grid-cols-2">{core.map((i) => <IntegrationCard key={i.key} i={i} />)}</div>
        <h3 className="mb-3 mt-6 text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-3">Optional</h3>
        <div className="grid gap-3 md:grid-cols-2">{optional.map((i) => <IntegrationCard key={i.key} i={i} />)}</div>
        {view.mode === "live" && <TelegramLink view={view} />}
      </section>

      <StyleGuide view={view} />
      <Schedule view={view} />
      <Sending view={view} />
    </div>
  );
}

function IntegrationCard({ i }: { i: IntegrationStatus }) {
  const { run } = useDispatch();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const s = STATE[i.state];
  const feature = GOOGLE_FEATURE[i.key];

  const doRun = async (label: string, fn: () => ReturnType<typeof run>) => {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    setResult(r.ok ? { ok: true, text: (r.data as { detail?: string } | null)?.detail ?? r.message ?? "Done" } : { ok: false, text: r.error.message });
  };

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{i.name}</p>
          <p className="text-[13px] text-ink-3">{i.purpose}</p>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="text-[13.5px] text-ink-2">{i.detail}</p>
      {i.lastError && <p className="text-[13px] text-bad">Last error: {i.lastError}</p>}
      {i.lastSuccessAt && <p className="text-[12.5px] text-ink-3">Last successful use {formatInZone(i.lastSuccessAt, "Asia/Kolkata", "short")}</p>}
      {i.missingEnv.length > 0 && (
        <p className="text-[12.5px] text-ink-3">
          Set {i.missingEnv.map((e) => <code key={e} className="mx-0.5 rounded bg-sunk px-1 py-0.5 text-[11.5px]">{e}</code>)} and redeploy.
        </p>
      )}
      {i.actions.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {(i.actions.includes("connect") || i.actions.includes("reconnect")) && feature && (
            <a href={`/api/google/connect?feature=${feature}`} className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-strong">
              {i.actions.includes("reconnect") ? "Reconnect Google" : "Connect Google"}
            </a>
          )}
          {i.actions.includes("test") && (
            <Button size="sm" busy={busy === "test"} onClick={() => doRun("test", () => run("testIntegration", { key: i.key }, { quiet: true }))}>
              Test connection
            </Button>
          )}
          {i.actions.includes("register_webhook") && (
            <Button size="sm" busy={busy === "hook"} onClick={() => doRun("hook", () => run("registerTelegramWebhook", {}, { quiet: true }))}>
              Register webhook
            </Button>
          )}
        </div>
      )}
      {result && <p role="status" className={`text-[13px] ${result.ok ? "text-ok" : "text-bad"}`}>{result.text}</p>}
    </Card>
  );
}

function TelegramLink({ view }: { view: SettingsView }) {
  const { run } = useDispatch();
  const [code, setCode] = useState<string | null>(view.telegram.linkCode);
  if (view.telegram.linked) return <p className="mt-4 text-sm text-ok">✓ Telegram is linked to your chat. Only that chat can review and approve.</p>;
  return (
    <Card className="mt-4 p-5">
      <p className="font-medium">Link your Telegram chat</p>
      <p className="mt-1 text-sm text-ink-2">
        Generate a one-time code, then send <code className="rounded bg-sunk px-1">/start CODE</code> to {view.telegram.botUsername ? <b>@{view.telegram.botUsername}</b> : "your bot"}. Only the linked chat can approve anything.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={async () => { const r = await run("createTelegramLinkCode", {}, { quiet: true }); if (r.ok) setCode(r.data.code); }}>Generate code</Button>
        {code && <code className="rounded bg-sunk px-2 py-1 text-[15px] tracking-widest">{code}</code>}
      </div>
    </Card>
  );
}

function StyleGuide({ view }: { view: SettingsView }) {
  const { run } = useDispatch();
  const [content, setContent] = useState(view.styleGuide.content);
  const [examples, setExamples] = useState(view.styleGuide.examples);
  const [status, setStatus] = useState<string | null>(null);
  const dirty = content !== view.styleGuide.content || examples !== view.styleGuide.examples;
  return (
    <section aria-labelledby="sg-h">
      <SectionTitle id="sg-h" sub={`Version ${view.styleGuide.version}. Each draft records the version it used. Editing doesn't rewrite existing commentary.`}>
        Editorial style guide
      </SectionTitle>
      <Card className="grid gap-4 p-5">
        {view.styleGuide.isStarter && <Callout tone="info">{STYLE_GUIDE_LABEL}. Adjust it to match Shreya&apos;s voice.</Callout>}
        <Field label="Guide" htmlFor="sg">
          <Textarea id="sg" rows={14} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-[13px]" />
        </Field>
        <Field label="Past writing examples (optional)" htmlFor="sg-ex" hint="Paste a few past commentaries. They help Gemini match tone; they're never required.">
          <Textarea id="sg-ex" rows={5} value={examples} onChange={(e) => setExamples(e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!dirty || !content.trim()}
            onClick={async () => {
              const r = await run("saveStyleGuide", { content, examples }, { quiet: true });
              setStatus(r.ok ? `Saved as version ${r.data.version}` : r.error.message);
            }}
          >
            Save guide
          </Button>
          <span role="status" className="text-[13px] text-ink-3">{dirty ? "Unsaved changes" : status}</span>
        </div>
      </Card>
    </section>
  );
}

function Schedule({ view }: { view: SettingsView }) {
  const { run } = useDispatch();
  const [s, setS] = useState<ScheduleConfig>(view.schedule);
  const [msg, setMsg] = useState<string | null>(null);
  const times: Array<[keyof ScheduleConfig, string]> = [
    ["collectTime", "Collection time (each collection day)"],
    ["draftTime", `Draft generation (${WEEKDAYS[s.draftDay]})`],
    ["draftDeliveryTime", `Draft to Telegram (${WEEKDAYS[s.draftDay]})`],
    ["reminderTime", `Missing-approval reminder (${WEEKDAYS[s.draftDay]})`],
    ["sendTime", `Newsletter send (${WEEKDAYS[s.sendDay]})`],
  ];
  const invalid = times.some(([k]) => !isValidHHMM(String(s[k])));
  return (
    <section aria-labelledby="sch-h">
      <SectionTitle id="sch-h" sub={`Times are in ${s.timezone}. The Wednesday 10 PM reminder comes from the brief; the other times are editable defaults.`}>Schedule</SectionTitle>
      <Card className="grid gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Timezone" htmlFor="tz">
            <Select id="tz" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"].map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
          {times.map(([k, label]) => (
            <Field key={k} label={label} htmlFor={k} error={isValidHHMM(String(s[k])) ? null : "Use HH:MM"}>
              <Input id={k} type="time" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={invalid} onClick={async () => { const r = await run("saveSchedule", { schedule: s }, { quiet: true }); setMsg(r.ok ? "Saved" : r.error.message); }}>Save schedule</Button>
          <span role="status" className="text-[13px] text-ink-3">{msg}</span>
        </div>
        <Disclosure summary="How scheduled runs work">
          <p className="text-[13px] leading-relaxed text-ink-2">{view.cron.note}</p>
          {view.cron.externalSchedulerUrl && (
            <p className="mt-2 text-[13px] text-ink-2">External scheduler endpoint: <code className="rounded bg-sunk px-1">{view.cron.externalSchedulerUrl}</code> (requires the cron secret as a Bearer token).</p>
          )}
        </Disclosure>
      </Card>
    </section>
  );
}

function Sending({ view }: { view: SettingsView }) {
  const { run } = useDispatch();
  const [f, setF] = useState({ ...view.sending, newsletterName: view.newsletter.name, footer: view.newsletter.footer });
  const [msg, setMsg] = useState<string | null>(null);
  const limitHint =
    f.accountType === "gmail" ? "Consumer Gmail: about 500 recipients per day." : f.accountType === "workspace" ? "Google Workspace: about 2,000 messages per user per day." : "Use the limit your provider documents.";
  return (
    <section aria-labelledby="send-h">
      <SectionTitle id="send-h" sub="Used when assembling and sending the approved edition.">Email</SectionTitle>
      <Card className="grid gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Newsletter name" htmlFor="nn"><Input id="nn" value={f.newsletterName} onChange={(e) => setF({ ...f, newsletterName: e.target.value })} /></Field>
          <Field label="From name" htmlFor="fn"><Input id="fn" value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></Field>
          <Field label="Reply-to (optional)" htmlFor="rt"><Input id="rt" type="email" value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} /></Field>
          <Field label="Account type" htmlFor="at" hint={limitHint}>
            <Select id="at" value={f.accountType} onChange={(e) => {
              const accountType = e.target.value as typeof f.accountType;
              setF({ ...f, accountType, dailyLimit: accountType === "gmail" ? 500 : accountType === "workspace" ? 2000 : f.dailyLimit });
            }}>
              <option value="gmail">Gmail (personal)</option>
              <option value="workspace">Google Workspace</option>
              <option value="custom">Custom limit</option>
            </Select>
          </Field>
          <Field label="Daily sending limit" htmlFor="dl" hint="Confirmation is blocked if active subscribers exceed this.">
            <Input id="dl" type="number" min={1} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Footer" htmlFor="ft"><Textarea id="ft" rows={2} value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} /></Field>
        <div className="flex items-center gap-3">
          <Button onClick={async () => { const r = await run("saveSending", f, { quiet: true }); setMsg(r.ok ? "Saved" : r.error.message); }}>Save email settings</Button>
          <span role="status" className="text-[13px] text-ink-3">{msg}</span>
        </div>
      </Card>
    </section>
  );
}
