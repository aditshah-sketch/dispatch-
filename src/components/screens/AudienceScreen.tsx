"use client";

import { useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import type { AudienceView } from "@/lib/views";
import { Badge, Button, Callout, Card, Disclosure, EmptyState, ErrorPanel, Field, Input, LoadingBlock, PageHeader, SectionTitle, Stat, Textarea } from "../ui";

export function AudienceScreen() {
  const { refresh } = useDispatch();
  const { data, error, loading } = useView((c) => c.audience());
  if (!data) return loading ? <LoadingBlock label="Loading audience…" /> : <ErrorPanel message={error ?? ""} onRetry={refresh} />;
  return <Audience view={data} />;
}

function Audience({ view }: { view: AudienceView }) {
  const { run } = useDispatch();
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const over = view.sending.dailyLimit != null && view.counts.ACTIVE > view.sending.dailyLimit;
  const list = view.subscribers.filter((s) => !q || s.email.includes(q.toLowerCase()) || (s.name ?? "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Audience" title="Subscribers">
        Unsubscribes and bounces are tracked separately. Both are excluded from every send and rechecked right before each message goes out.
      </PageHeader>

      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Active" value={view.counts.ACTIVE.toLocaleString("en-IN")} />
        <Stat label="Unsubscribed" value={view.counts.UNSUBSCRIBED.toLocaleString("en-IN")} />
        <Stat label="Bounced" value={view.counts.BOUNCED.toLocaleString("en-IN")} sub="Permanent failures, suppressed" />
        <Stat label="Daily send limit" value={view.sending.dailyLimit?.toLocaleString("en-IN") ?? "—"} sub={view.sending.accountLabel} tone={over ? "bad" : undefined} />
      </div>

      {over && (
        <Callout tone="bad" title="This list is larger than the sending account can handle in one day">
          {view.counts.ACTIVE.toLocaleString("en-IN")} active subscribers vs a configured limit of {view.sending.dailyLimit?.toLocaleString("en-IN")} for {view.sending.account ?? "the connected account"}.
          Gmail can&apos;t deliver the full list on Thursday morning, and The Dispatch will not quietly spread it over several days. Use a smaller list for now, or plan a move to a bulk email provider.
        </Callout>
      )}

      <section aria-labelledby="add-h">
        <SectionTitle id="add-h">Add subscribers</SectionTitle>
        <Card className="p-5">
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const r = await run("addSubscribers", { text }, { quiet: true });
              setBusy(false);
              if (r.ok) {
                setResult(`Added ${r.data.added}.${r.data.skipped ? ` ${r.data.skipped} already on the list — their status (including unsubscribes) was kept.` : ""}${r.data.invalid.length ? ` Invalid: ${r.data.invalid.slice(0, 5).join(", ")}` : ""}`);
                setText("");
              } else setResult(r.error.message);
            }}
          >
            <Field label="Email addresses" htmlFor="subs" hint="One per line, optionally followed by a comma and a name. Paste from a CSV export.">
              <Textarea id="subs" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"reader@example.com, Reader Name"} />
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!text.trim()} busy={busy}>Add</Button>
              {result && <span role="status" className="text-sm text-ink-2">{result}</span>}
            </div>
          </form>
        </Card>
      </section>

      <section aria-labelledby="list-h">
        <SectionTitle id="list-h" action={<Input aria-label="Search subscribers" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />}>
          List
        </SectionTitle>
        {view.subscribers.length === 0 ? (
          <EmptyState title="No subscribers yet">Add a few addresses above to try a small send.</EmptyState>
        ) : (
          <Card as="div" className="divide-y divide-rule">
            {list.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.email}</p>
                  <p className="text-[12.5px] text-ink-3">{s.name ?? "—"}{s.reason ? ` · ${s.reason}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={s.status === "ACTIVE" ? "ok" : s.status === "BOUNCED" ? "bad" : "neutral"}>{s.status.toLowerCase()}</Badge>
                  {s.status === "ACTIVE" && (
                    <Button size="sm" variant="ghost" onClick={() => run("setSubscriberStatus", { id: s.id, status: "UNSUBSCRIBED" }, { quiet: true })}>Unsubscribe</Button>
                  )}
                  {s.status === "BOUNCED" && (
                    <Button size="sm" variant="ghost" title="Only if you know the address works again" onClick={() => run("setSubscriberStatus", { id: s.id, status: "ACTIVE" })}>Reactivate</Button>
                  )}
                </div>
              </div>
            ))}
            {view.truncated && <p className="px-5 py-3 text-[13px] text-ink-3">Showing the first {view.subscribers.length}. Use search to find others.</p>}
          </Card>
        )}
      </section>

      <section aria-labelledby="fb-h">
        <SectionTitle id="fb-h" sub={view.feedbackEnabled ? "Bounce notices from the sending mailbox, checked on a schedule." : "Bounce checking is off. Enable it in Settings → Gmail delivery feedback (needs read access to the mailbox)."}>
          Delivery feedback
        </SectionTitle>
        {view.feedback.length === 0 ? (
          <p className="text-sm text-ink-3">No bounce notices processed yet.</p>
        ) : (
          <Card as="div" className="divide-y divide-rule text-[13.5px]">
            {view.feedback.map((f) => (
              <div key={f.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:justify-between">
                <span>
                  <Badge tone={f.kind === "PERMANENT_BOUNCE" ? "bad" : f.kind === "TEMPORARY_BOUNCE" ? "warn" : "neutral"}>{f.kind.replace("_", " ").toLowerCase()}</Badge>{" "}
                  {f.recipient ?? "unmatched"}
                </span>
                <span className="text-ink-3">{f.detail}</span>
              </div>
            ))}
          </Card>
        )}
        <Disclosure summary="How unsubscribes and bounces differ" className="mt-3">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
            <li><b>Unsubscribe</b> — the reader asked to stop. Every email has a personal link (no login) plus one-click unsubscribe headers. The link opens a confirmation page, so security scanners can&apos;t unsubscribe people by accident.</li>
            <li><b>Permanent bounce</b> (5.x.x) — the address doesn&apos;t work. It is suppressed with the reason recorded.</li>
            <li><b>Temporary bounce</b> (4.x.x) — recorded, not treated as an unsubscribe. After 3 temporary failures across different campaigns the address is suppressed.</li>
            <li>Re-importing an address never reactivates someone who unsubscribed.</li>
          </ul>
        </Disclosure>
      </section>
    </div>
  );
}
