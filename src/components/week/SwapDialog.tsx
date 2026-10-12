"use client";

import { useState } from "react";
import { useDispatch, useView } from "@/lib/client/context";
import { topicLabel } from "@/lib/domain/topics";
import type { EditionStory } from "@/lib/domain/types";
import { Badge, Button, Dialog, EmptyState, ExternalLink, LoadingBlock } from "../ui";

export function SwapDialog({ story, onClose }: { story: EditionStory; onClose: () => void }) {
  const { run } = useDispatch();
  const { data, error, loading } = useView((c) => c.alternatives(story.id), [story.id]);
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Swap #${story.position}`}
      description={<>Replacing “{story.headline}”. The rest of the draft stays as it is.</>}
    >
      {loading && !data ? (
        <LoadingBlock label="Finding eligible alternatives…" />
      ) : error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : !data?.alternatives.length ? (
        <EmptyState title="No eligible alternatives">
          Every other collected article is a duplicate, covers an event already in the draft, or ran in a recent edition. Run another collection or keep this story.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-rule">
          {data.alternatives.map(({ candidate: c, impact, sameTopic }) => (
            <li key={c.articleId} className="flex flex-col gap-2 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={sameTopic ? "neutral" : "info"}>{topicLabel(c.topic)}</Badge>
                  {c.score != null && <Badge tone="neutral" title="Editorial heuristic, not a probability">Score {c.score}</Badge>}
                  {c.historyNote && <Badge tone="warn">Covered company</Badge>}
                  {!c.commentary && <Badge tone="warn">Needs commentary</Badge>}
                </div>
                <p className="font-serif text-[17px] font-semibold leading-snug">
                  <ExternalLink href={c.url}>{c.headline}</ExternalLink>
                </p>
                <p className="mt-0.5 text-[13px] text-ink-3">{c.publisher}</p>
                <p className="mt-1.5 text-[13.5px] text-ink-2">{c.rationale}</p>
                <p className={`mt-1 text-[12.5px] ${/below the minimum/.test(impact) ? "text-bad" : "text-ink-3"}`}>{impact}</p>
              </div>
              <Button
                size="sm"
                variant="primary"
                className="shrink-0"
                busy={busy === c.articleId}
                disabled={!!busy}
                onClick={async () => {
                  setBusy(c.articleId);
                  const r = await run("swapStory", { storyId: story.id, articleId: c.articleId });
                  setBusy(null);
                  if (r.ok) onClose();
                }}
              >
                Use this story
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
