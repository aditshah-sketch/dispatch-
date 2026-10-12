"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { formatInZone, formatYmd } from "@/lib/domain/schedule";
import { topicLabel } from "@/lib/domain/topics";
import type { ArticleRow, ArticlesView } from "@/lib/views";
import { Badge, Button, Callout, Card, Disclosure, EmptyState, ErrorPanel, ExternalLink, Input, LoadingBlock, PageHeader, SectionTitle, Select, type Tone } from "../ui";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "eligible", label: "Eligible" },
  { key: "in_draft", label: "In draft" },
  { key: "same_event", label: "Same event" },
  { key: "duplicate", label: "Duplicates" },
  { key: "covered", label: "Already covered" },
  { key: "out_of_window", label: "Too old" },
] as const;

const STATUS: Record<ArticleRow["status"], { label: string; tone: Tone }> = {
  in_draft: { label: "In draft", tone: "accent" },
  eligible: { label: "Eligible", tone: "ok" },
  duplicate: { label: "Duplicate", tone: "neutral" },
  same_event: { label: "Same event", tone: "info" },
  covered: { label: "Already covered", tone: "warn" },
  out_of_window: { label: "Too old", tone: "neutral" },
};

const EXTRACTION: Record<ArticleRow["extractionStatus"], string> = {
  FEED_ONLY: "Feed summary only",
  EXTRACTED: "Full text",
  PARTIAL: "Partial text",
  FAILED: "Page fetch failed",
  BLOCKED: "Paywalled / blocked",
  SKIPPED: "Not fetched",
};

export function ArticlesScreen() {
  const { refresh } = useDispatch();
  const { data, error, loading } = useView((c) => c.articles());
  if (!data) return loading ? <LoadingBlock label="Loading articles…" /> : <ErrorPanel message={error ?? ""} onRetry={refresh} />;
  return <Articles view={data} />;
}

function Articles({ view }: { view: ArticlesView }) {
  const { run, mode } = useDispatch();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: view.rows.length };
    for (const r of view.rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [view.rows]);

  const rows = view.rows.filter(
    (r) => (filter === "all" || r.status === filter) && (!q || `${r.headline} ${r.publisher}`.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={view.isSample ? "Articles · sample collection" : "Articles"}
        title="What came in this week"
        actions={
          <Button variant="primary" busy={busy === "collect"} busyLabel="Collecting…" onClick={async () => { setBusy("collect"); await run("collect", {}); setBusy(null); }}>
            {mode === "preview" ? "Re-run sample collection" : "Collect now"}
          </Button>
        }
      >
        For the edition of {formatYmd(view.publishDate)} · window from {formatInZone(view.windowStart, view.timezone, "short")}
      </PageHeader>

      {view.isSample && (
        <Callout tone="warn" title="These are fictional sample articles">
          They were not fetched from the internet. They are placed in this week&apos;s window so you can see how duplicates, same-event coverage and history checks behave.
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Collected", view.counts.total],
          ["Eligible events", view.counts.eligible],
          ["Exact duplicates", view.counts.duplicates],
          ["Same-event coverage", view.counts.sameEvent],
          ["Already covered", view.counts.covered],
          ["Too old", view.counts.outOfWindow],
        ].map(([l, v]) => (
          <div key={l} className="rounded-md border border-rule bg-surface px-3 py-2.5">
            <div className="text-[11.5px] uppercase tracking-[0.06em] text-ink-3">{l}</div>
            <div className="font-serif text-[22px] font-semibold">{v}</div>
          </div>
        ))}
      </div>

      <section aria-labelledby="list-h">
        <h2 id="list-h" className="sr-only">Article list</h2>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div role="tablist" aria-label="Filter articles" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={clsx(
                  "shrink-0 rounded-full border px-3 py-1 text-[13px] font-medium",
                  filter === f.key ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-sunk",
                )}
              >
                {f.label} <span className="opacity-70 tabular-nums">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <Input aria-label="Search articles" placeholder="Search headlines or publishers" value={q} onChange={(e) => setQ(e.target.value)} className="sm:w-64" />
        </div>

        {view.rows.length === 0 ? (
          <EmptyState title="No articles yet" action={<Button variant="primary" onClick={() => run("collect", {})}>Collect now</Button>}>
            Collection runs Monday to Wednesday on the schedule in Settings. You can also run it now.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing matches this filter" />
        ) : (
          <Card as="div" className="divide-y divide-rule">
            {rows.map((r) => (
              <div key={r.id} className={clsx("flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-6", (r.status === "duplicate" || r.status === "out_of_window") && "opacity-75")}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATUS[r.status].tone}>{r.draftPosition ? `In draft · #${r.draftPosition}` : STATUS[r.status].label}</Badge>
                    <Badge>{topicLabel(r.topic)}</Badge>
                    {r.clusterSize > 1 && <Badge tone="info" title="Articles reporting the same event">{r.clusterSize} sources</Badge>}
                    {r.historyFlag && <Badge tone="warn">Covered company</Badge>}
                  </div>
                  <p className="font-serif text-[17px] font-semibold leading-snug">
                    <ExternalLink href={r.url}>{r.headline}</ExternalLink>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    {r.publisher} · {r.publishedAt ? formatInZone(r.publishedAt, view.timezone, "short") : "date unknown"} · {r.provenance === "news_api" ? "news search" : r.provenance} · {EXTRACTION[r.extractionStatus]}
                  </p>
                  {r.reason && <p className="mt-1.5 text-[13px] text-ink-2">{r.reason}</p>}
                  {r.historyFlag && <p className="mt-1.5 text-[13px] text-warn">{r.historyFlag}</p>}
                  {r.description && (
                    <Disclosure summary="Summary & evidence" className="mt-1.5">
                      <p className="text-[13.5px] leading-relaxed text-ink-2">{r.description}</p>
                      {r.evidenceNotes.length > 0 && <p className="mt-1 text-[12.5px] text-ink-3">{r.evidenceNotes.join(" · ")}</p>}
                    </Disclosure>
                  )}
                </div>
                {r.status === "eligible" && view.canAddToDraft && (
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={view.draftSize >= 10}
                    title={view.draftSize >= 10 ? "The draft already has 10 stories" : undefined}
                    busy={busy === r.id}
                    onClick={async () => { setBusy(r.id); await run("addStory", { articleId: r.id }); setBusy(null); }}
                  >
                    Add to draft
                  </Button>
                )}
              </div>
            ))}
          </Card>
        )}
      </section>

      <Sources view={view} />
    </div>
  );
}

function Sources({ view }: { view: ArticlesView }) {
  const { run, mode } = useDispatch();
  const [kind, setKind] = useState<"rss" | "news_query">("rss");
  const [name, setName] = useState("");
  const [locator, setLocator] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const failed = view.sources.filter((s) => s.lastStatus === "FAILED");

  return (
    <section aria-labelledby="sources-h">
      <SectionTitle id="sources-h" sub="One failing source never stops the others.">Sources</SectionTitle>
      {failed.length > 0 && (
        <div className="mb-3">
          <Callout tone="warn" title={`${failed.length} source${failed.length > 1 ? "s" : ""} failed on the last run`}>
            The rest of the collection completed normally. Details are shown on each source below.
          </Callout>
        </div>
      )}
      {view.newsApiNote && <div className="mb-3"><Callout tone="info">{view.newsApiNote}</Callout></div>}
      <Card as="div" className="divide-y divide-rule">
        {view.sources.map((s) => (
          <div key={s.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium">
                {s.name} <span className="text-[12px] font-normal text-ink-3">· {s.kind === "rss" ? "RSS" : "News search"}</span>
              </p>
              <p className="truncate text-[12.5px] text-ink-3" title={s.locator}>{s.locator}</p>
              <p className="text-[12.5px]">
                {s.lastStatus === "OK" && <span className="text-ok">OK · {s.lastItemCount} items</span>}
                {s.lastStatus === "EMPTY" && <span className="text-warn">Reachable but no items</span>}
                {s.lastStatus === "FAILED" && <span className="text-bad">Failed: {s.lastError}</span>}
                {s.lastStatus === "SKIPPED" && <span className="text-ink-3">{s.lastError ?? "Not run"}</span>}
                {s.lastRunAt && <span className="text-ink-3"> · {formatInZone(s.lastRunAt, view.timezone, "short")}</span>}
                {s.verifiedNote && <span className="text-ink-3"> · {s.verifiedNote}</span>}
              </p>
            </div>
            <label className="inline-flex shrink-0 items-center gap-2 text-[13px]">
              <input type="checkbox" checked={s.enabled} onChange={(e) => run("toggleSource", { id: s.id, enabled: e.target.checked }, { quiet: true })} className="accent-[var(--color-accent)]" />
              Enabled
            </label>
          </div>
        ))}
        {view.runs.length > 0 && (
          <div className="px-5 py-3.5">
            <Disclosure summary="Recent collection runs">
              <ul className="space-y-1 text-[13px]">
                {view.runs.map((r) => (
                  <li key={r.id}>
                    <span className="text-ink-3">{formatInZone(r.startedAt, view.timezone, "short")} · {r.trigger} · </span>
                    <span className={r.status === "FAILED" ? "text-bad" : r.status === "PARTIAL" ? "text-warn" : ""}>{r.status}</span> — {r.summary}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )}
      </Card>
      {mode === "live" && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-[140px_1fr_2fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const r = await run("addSource", { kind, name, locator });
            if (r.ok) { setName(""); setLocator(""); } else setErr(r.error.message);
          }}
        >
          <Select aria-label="Source type" value={kind} onChange={(e) => setKind(e.target.value as "rss" | "news_query")}>
            <option value="rss">RSS feed</option>
            <option value="news_query">News query</option>
          </Select>
          <Input aria-label="Source name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input aria-label={kind === "rss" ? "Feed URL" : "Search query"} placeholder={kind === "rss" ? "https://…/feed" : "e.g. startup layoffs India"} value={locator} onChange={(e) => setLocator(e.target.value)} required />
          <Button type="submit">Add source</Button>
          {err && <p className="text-[13px] text-bad sm:col-span-4" role="alert">{err}</p>}
        </form>
      )}
    </section>
  );
}
