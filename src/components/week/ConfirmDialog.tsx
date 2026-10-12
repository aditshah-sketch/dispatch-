"use client";

import { useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { formatInZone, tzAbbreviation, zonedTimeToUtc } from "@/lib/domain/schedule";
import { topicLabel } from "@/lib/domain/topics";
import { Badge, Button, Callout, Dialog, Input, LoadingBlock } from "../ui";

type When = "default" | "now" | "custom";

export function ConfirmDialog({ onClose }: { onClose: () => void }) {
  const { client, run, mode } = useDispatch();
  const { data, error, loading } = useView((c) => c.emailPreview(), []);
  const [when, setWhen] = useState<When | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tab, setTab] = useState<"html" | "text">("html");

  const effectiveWhen: When = when ?? (data?.sendTimePassed ? "custom" : "default");

  const submit = async () => {
    if (!data) return;
    setFormError(null);
    let sendAt: string | null = null;
    if (effectiveWhen === "default") sendAt = data.defaultSendAt;
    if (effectiveWhen === "custom") {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(custom);
      if (!m) return setFormError("Choose a date and time.");
      sendAt = zonedTimeToUtc(m[1], m[2], data.timezone).toISOString();
      if (Date.parse(sendAt) < Date.now() + 60_000) return setFormError("That time has passed. Choose a later time or Send now.");
    }
    setBusy(true);
    const r = await run("confirmEdition", { revision: data.revision, contentHash: data.contentHash, sendNow: effectiveWhen === "now", sendAt });
    setBusy(false);
    if (r.ok) onClose();
    else setFormError(r.error.message);
  };

  const tz = data ? tzAbbreviation(data.timezone) : "";

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title="Review and confirm the edition"
      description="This is exactly what subscribers will receive. Confirming approves this revision as a whole."
      footer={
        data && (
          <>
            {formError && <p className="mr-auto text-[13px] text-bad" role="alert">{formError}</p>}
            <Button variant="ghost" onClick={onClose}>Keep reviewing</Button>
            <Button variant="primary" size="lg" busy={busy} busyLabel="Confirming…" disabled={data.report.blockers.length > 0} onClick={submit}>
              {effectiveWhen === "now" ? `Confirm and send now` : `Confirm revision ${data.revision}`}
            </Button>
          </>
        )
      }
    >
      {loading && !data ? (
        <LoadingBlock label="Rendering the email…" />
      ) : error || !data ? (
        <p className="text-sm text-bad">{error ?? "Couldn't prepare the preview."}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="truncate text-sm">
                <span className="text-ink-3">Subject: </span>
                <span className="font-medium">{data.subject || <em className="text-bad">missing</em>}</span>
              </p>
              <div className="flex shrink-0 rounded-md border border-rule p-0.5 text-[12px]" role="tablist" aria-label="Email format">
                {(["html", "text"] as const).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded px-2 py-1 ${tab === t ? "bg-sunk font-medium" : "text-ink-3"}`}>
                    {t === "html" ? "Email" : "Plain text"}
                  </button>
                ))}
              </div>
            </div>
            {tab === "html" ? (
              <iframe title="Email preview" sandbox="" srcDoc={data.html} className="h-[62dvh] w-full rounded-md border border-rule bg-paper" />
            ) : (
              <pre className="h-[62dvh] overflow-auto whitespace-pre-wrap rounded-md border border-rule bg-paper p-4 font-mono text-[12.5px] leading-relaxed">{data.text}</pre>
            )}
          </div>

          <aside className="space-y-5 text-sm">
            <dl className="space-y-2.5">
              <Row label="Revision">{data.revision} <span className="text-ink-3">· {data.report.topics.length} topics</span></Row>
              <Row label="Recipients">
                {data.recipients.toLocaleString("en-IN")} eligible
                <span className="block text-[12px] text-ink-3">Unsubscribed and bounced addresses are excluded and rechecked just before sending.</span>
              </Row>
              <Row label="Sending account">{data.sender ?? <span className="text-bad">Not connected</span>}</Row>
            </dl>

            <div className="flex flex-wrap gap-1">
              {data.report.topics.map((t) => <Badge key={t}>{topicLabel(t)}</Badge>)}
            </div>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">When to send ({tz})</legend>
              <div className="space-y-2">
                <Choice checked={effectiveWhen === "default"} disabled={data.sendTimePassed} onChange={() => setWhen("default")}>
                  {formatInZone(data.defaultSendAt, data.timezone)}
                  {data.sendTimePassed && <span className="block text-[12px] text-ink-3">This time has passed.</span>}
                </Choice>
                <Choice checked={effectiveWhen === "now"} onChange={() => setWhen("now")}>Send now</Choice>
                <Choice checked={effectiveWhen === "custom"} onChange={() => setWhen("custom")}>Another time</Choice>
                {effectiveWhen === "custom" && (
                  <Input type="datetime-local" aria-label={`Send time in ${tz}`} value={custom} onChange={(e) => setCustom(e.target.value)} />
                )}
              </div>
              {data.sendTimePassed && (
                <p className="mt-2 text-[12px] text-ink-3">Late approvals are never sent automatically — you choose the time.</p>
              )}
            </fieldset>

            {data.report.blockers.length > 0 && (
              <Callout tone="bad" title="Can't confirm yet">
                <ul className="mt-1 list-disc space-y-1 pl-4">{data.report.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </Callout>
            )}
            {data.report.warnings.length > 0 && (
              <Callout tone="warn" title="Worth a look before confirming">
                <ul className="mt-1 list-disc space-y-1 pl-4">{data.report.warnings.slice(0, 6).map((w) => <li key={w}>{w}</li>)}</ul>
              </Callout>
            )}
            <p className="text-[12px] leading-relaxed text-ink-3">
              Confirming also marks any stories you haven&apos;t individually reviewed as approved. If anything changes after this, the approval is withdrawn and you&apos;ll be asked to confirm again.
              {mode === "preview" && " In preview, delivery is simulated."}
            </p>
            {client.mode === "live" && <p className="sr-only">Live mode</p>}
          </aside>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function Choice({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${checked ? "border-accent bg-accent-soft/50" : "border-rule"} ${disabled ? "cursor-not-allowed opacity-55" : ""}`}>
      <input type="radio" name="when" className="mt-1 accent-[var(--color-accent)]" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}
