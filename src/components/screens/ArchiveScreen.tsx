"use client";

import { useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { formatYmd } from "@/lib/domain/schedule";
import type { ArchiveView } from "@/lib/views";
import { Badge, Button, Callout, Card, Disclosure, EmptyState, ErrorPanel, ExternalLink, Field, Input, LoadingBlock, PageHeader, SectionTitle, Textarea } from "../ui";

export function ArchiveScreen() {
  const { refresh } = useDispatch();
  const { data, error, loading } = useView((c) => c.archive());
  if (!data) return loading ? <LoadingBlock label="Loading archive…" /> : <ErrorPanel message={error ?? ""} onRetry={refresh} />;
  return <Archive view={data} />;
}

function Archive({ view }: { view: ArchiveView }) {
  const { mode } = useDispatch();
  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Archive" title="Published editions">
        The previous four published editions form the editorial memory used to avoid repeating stories.
      </PageHeader>

      <Callout tone={view.history.checked >= view.history.depth ? "ok" : "info"} title={`Editorial memory: ${view.history.checked} of ${view.history.depth} editions`}>
        {view.history.label}. Drafts and unapproved editions never count. An edition joins the memory as soon as at least one recipient&apos;s copy is accepted, even if the rest of the campaign later fails.
      </Callout>

      {view.editions.length === 0 ? (
        <EmptyState title="No published editions yet">
          Your first edition will appear here once it is sent. Importing past editions is optional and only improves the repeat-coverage check.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {view.editions.map((e) => (
            <Card key={e.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-serif text-[18px] font-semibold">{formatYmd(e.publishDate)}</p>
                {e.issueNumber && <span className="text-[13px] text-ink-3">Issue {e.issueNumber}</span>}
                {e.inMemoryWindow && <Badge tone="accent">In memory window</Badge>}
                {e.origin === "import" && <Badge>Imported</Badge>}
                {e.origin === "sample" && <Badge tone="warn">Sample</Badge>}
                {e.status === "PARTIALLY_SENT" && <Badge tone="warn">Partially sent</Badge>}
              </div>
              <p className="mt-0.5 text-sm text-ink-2">{e.subject}</p>
              {e.delivery && (
                <p className="mt-1 text-[12.5px] text-ink-3">
                  {e.delivery.accepted} accepted · {e.delivery.failed} failed · {e.delivery.unknown} uncertain of {e.delivery.total}
                </p>
              )}
              <Disclosure summary={`${e.stories.length} stories`} className="mt-2">
                <ol className="list-decimal space-y-1 pl-5 text-[13.5px]">
                  {e.stories.map((s) => (
                    <li key={s.url + s.headline}>
                      <ExternalLink href={s.url}>{s.headline}</ExternalLink> <span className="text-ink-3">— {s.publisher}</span>
                    </li>
                  ))}
                </ol>
              </Disclosure>
            </Card>
          ))}
        </div>
      )}

      {mode === "live" && <ImportForm />}
    </div>
  );
}

function ImportForm() {
  const { run } = useDispatch();
  const [date, setDate] = useState("");
  const [subject, setSubject] = useState("");
  const [stories, setStories] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-labelledby="import-h">
      <SectionTitle id="import-h" sub="Optional. Add past editions so the first few drafts can avoid repeats.">Import a past edition</SectionTitle>
      <Card className="p-5">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await run("importHistory", { publishDate: date, subject, stories }, { quiet: true });
            setBusy(false);
            setMsg(r.ok ? { ok: true, text: `Imported ${r.data.stories} stories.` } : { ok: false, text: r.error.message });
            if (r.ok) { setStories(""); setSubject(""); }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Publication date" htmlFor="imp-date"><Input id="imp-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Subject" htmlFor="imp-sub"><Input id="imp-sub" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          </div>
          <Field label="Stories" htmlFor="imp-stories" hint="One per line: headline | URL | publisher (publisher optional)">
            <Textarea id="imp-stories" rows={5} required value={stories} onChange={(e) => setStories(e.target.value)} placeholder="Kirana Cloud raises $18M | https://… | Inc42" />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" busy={busy}>Import</Button>
            {msg && <span role="status" className={msg.ok ? "text-sm text-ok" : "text-sm text-bad"}>{msg.text}</span>}
          </div>
        </form>
      </Card>
    </section>
  );
}
