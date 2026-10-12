"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "@/lib/client/context";
import { formatInZone } from "@/lib/domain/schedule";
import { splitSentences } from "@/lib/domain/text";
import { topicLabel, TOPIC_IDS, TOPICS, type TopicId } from "@/lib/domain/topics";
import type { ContentOrigin, EditionStory } from "@/lib/domain/types";
import { Badge, Button, Disclosure, ExternalLink, Select, Textarea } from "../ui";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

const ORIGIN_LABEL: Record<ContentOrigin, { text: string; tone: "neutral" | "info" | "warn" | "ok" }> = {
  ai: { text: "Gemini draft", tone: "info" },
  editor: { text: "Edited by you", tone: "ok" },
  sample: { text: "Sample commentary (prewritten)", tone: "warn" },
  rules: { text: "Rule-based", tone: "neutral" },
  empty: { text: "Needs commentary", tone: "warn" },
};

const draftKey = (editionId: string, storyId: string) => `dispatch.unsaved.${editionId}.${storyId}`;

function readUnsaved(editionId: string, storyId: string): string | null {
  try {
    return typeof window === "undefined" ? null : sessionStorage.getItem(draftKey(editionId, storyId));
  } catch {
    return null; // storage unavailable
  }
}

export function StoryCard({
  story,
  editionId,
  timezone,
  frozen,
  canRegenerate,
  onSwap,
  onFollowUp,
  isFirst,
  isLast,
}: {
  story: EditionStory;
  editionId: string;
  timezone: string;
  frozen: boolean;
  canRegenerate: boolean;
  onSwap: () => void;
  onFollowUp: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { run } = useDispatch();
  // Unsaved text from a previous reload of this tab is restored first.
  const [text, setText] = useState(() => readUnsaved(editionId, story.id) ?? story.commentary);
  const [baseVersion, setBaseVersion] = useState(story.version);
  const [save, setSave] = useState<SaveState>(() => (readUnsaved(editionId, story.id) ?? story.commentary) !== story.commentary ? "dirty" : "idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<EditionStory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [seenVersion, setSeenVersion] = useState(story.version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values for the autosave timer (updated in handlers, not render).
  const textRef = useRef(text);
  const versionRef = useRef(baseVersion);
  const inFlight = useRef(false);

  // Accept server changes (e.g. from Telegram) only when the editor has no
  // unsaved work — never overwrite what Shreya is typing.
  if (story.version !== seenVersion) {
    setSeenVersion(story.version);
    if (story.version !== baseVersion && (save === "idle" || save === "saved")) {
      setText(story.commentary);
      setBaseVersion(story.version);
    }
  }
  useEffect(() => {
    textRef.current = text;
    versionRef.current = baseVersion;
  }, [text, baseVersion]);

  const persist = useCallback(
    async (value: string, version: number) => {
      inFlight.current = true;
      setSave("saving");
      const r = await run("editStory", { storyId: story.id, baseVersion: version, patch: { commentary: value } }, { quiet: true });
      inFlight.current = false;
      if (r.ok) {
        versionRef.current = r.data.story.version;
        setBaseVersion(r.data.story.version);
        if (textRef.current === value) {
          setSave("saved");
          try {
            sessionStorage.removeItem(draftKey(editionId, story.id));
          } catch {}
        } else setSave("dirty");
        setSaveError(null);
      } else if (r.error.code === "CONFLICT") {
        setConflict((r.error.current as EditionStory) ?? null);
        setSave("conflict");
      } else {
        setSave("error");
        setSaveError(r.error.message);
      }
    },
    [run, story.id, editionId],
  );

  const onChange = (value: string) => {
    textRef.current = value;
    setText(value);
    setSave("dirty");
    try {
      sessionStorage.setItem(draftKey(editionId, story.id), value);
    } catch {}
    schedule(value, 1100);
  };

  // One save at a time; a save that would overlap waits for the previous one,
  // so our own autosaves never conflict with each other.
  const schedule = (value: string, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (inFlight.current) schedule(textRef.current, 500);
      else if (textRef.current === value) persist(value, versionRef.current);
    }, delay);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const sentences = splitSentences(text).length;
  const approved = story.reviewStatus === "APPROVED";
  const origin = ORIGIN_LABEL[story.commentaryOrigin];

  return (
    <article
      id={`story-${story.id}`}
      aria-labelledby={`h-${story.id}`}
      className={clsx("rounded-lg border bg-surface transition-colors", approved ? "border-ok/30" : "border-rule")}
    >
      <div className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="font-serif text-[15px] font-semibold text-accent">#{story.position}</span>
          <Badge tone="neutral">{topicLabel(story.topic)}</Badge>
          {approved ? <Badge tone="ok">✓ Reviewed</Badge> : <Badge tone="neutral">Not yet reviewed</Badge>}
          {story.historyNote && <Badge tone="warn" title={story.historyNote}>Covered company</Badge>}
          {story.warnings.length > 0 && <Badge tone="warn">Limited evidence</Badge>}
        </div>

        <div>
          <h3 id={`h-${story.id}`} className="font-serif text-[21px] font-semibold leading-snug text-ink">
            <ExternalLink href={story.url}>{story.headline}</ExternalLink>
          </h3>
          <p className="mt-1 text-[13px] text-ink-3">
            {story.publisher}
            {story.publishedAt && <> · {formatInZone(story.publishedAt, timezone, "short")}</>}
            {story.corroborating.length > 0 && <> · also reported by {story.corroborating.length} other source{story.corroborating.length > 1 ? "s" : ""}</>}
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`c-${story.id}`} className="text-[13px] font-medium text-ink">
              Commentary <Badge tone={origin.tone} className="ml-1 align-middle">{origin.text}</Badge>
            </label>
            <SaveIndicator state={save} error={saveError} onRetry={() => persist(text, baseVersion)} />
          </div>
          <Textarea
            id={`c-${story.id}`}
            autoGrow
            rows={3}
            value={text}
            disabled={frozen}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Two to three sentences: what happened, then why it matters."
            className="font-serif text-[16.5px] leading-[1.6]"
            aria-describedby={`cc-${story.id}`}
          />
          <p id={`cc-${story.id}`} className={clsx("mt-1 text-[12px]", sentences >= 2 && sentences <= 3 ? "text-ink-3" : "text-warn")}>
            {sentences} sentence{sentences === 1 ? "" : "s"} · format is 2–3
          </p>
          {save === "conflict" && conflict && (
            <div className="mt-3 rounded-md border border-warn/30 bg-warn-soft p-3 text-sm" role="alert">
              <p className="font-semibold text-warn">This story changed elsewhere while you were editing.</p>
              <p className="mt-1 text-ink-2">Current saved version:</p>
              <blockquote className="mt-1 border-l-2 border-warn/40 pl-3 font-serif text-ink">{conflict.commentary || "(empty)"}</blockquote>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => { setConflict(null); persist(text, conflict.version); }}>
                  Keep my text
                </Button>
                <Button size="sm" onClick={() => { setText(conflict.commentary); setBaseVersion(conflict.version); setConflict(null); setSave("idle"); try { sessionStorage.removeItem(draftKey(editionId, story.id)); } catch {} }}>
                  Use saved version
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-md bg-sunk/70 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">Why it&apos;s here: </span>
          {story.rationale || "Added by you."}
          {story.rationaleOrigin === "sample" && <span className="text-ink-3"> (sample rationale)</span>}
          {story.rationaleOrigin === "rules" && <span className="text-ink-3"> (rule-based summary, not AI)</span>}
        </div>

        {(story.warnings.length > 0 || story.historyNote) && (
          <ul className="space-y-1 text-[13px] text-warn">
            {story.historyNote && <li>⚑ {story.historyNote}</li>}
            {story.warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}

        {!frozen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
            <Button
              size="sm"
              variant={approved ? "secondary" : "primary"}
              busy={busy === "approve"}
              onClick={() => act("approve", () => run("setStoryReview", { storyId: story.id, approved: !approved }, { quiet: true }))}
              aria-pressed={approved}
            >
              {approved ? "Reviewed ✓" : "Approve"}
            </Button>
            <Button size="sm" onClick={onSwap}>Swap</Button>
            {confirmRemove ? (
              <span className="inline-flex items-center gap-2 rounded-md bg-bad-soft px-2 py-1 text-[13px] text-bad">
                Remove this story?
                <Button size="sm" variant="danger" busy={busy === "remove"} onClick={() => act("remove", () => run("removeStory", { storyId: story.id }))}>
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>Remove</Button>
            )}
            <span className="hidden flex-1 sm:block" />
            <Disclosure summary="More">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" disabled={isFirst} onClick={() => run("moveStory", { storyId: story.id, direction: -1 }, { quiet: true })}>Move up</Button>
                <Button size="sm" variant="ghost" disabled={isLast} onClick={() => run("moveStory", { storyId: story.id, direction: 1 }, { quiet: true })}>Move down</Button>
                <TopicSelect story={story} />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canRegenerate || save === "dirty" || save === "saving"}
                  title={canRegenerate ? "Rewrites only this story's commentary" : "Needs Gemini"}
                  busy={busy === "regen"}
                  busyLabel="Rewriting…"
                  onClick={() => act("regen", () => run("regenerateCommentary", { storyId: story.id, baseVersion: story.version }))}
                >
                  Regenerate this commentary
                </Button>
                <Button size="sm" variant="ghost" onClick={onFollowUp}>Plan follow-up…</Button>
              </div>
            </Disclosure>
          </div>
        )}

        {(story.scores || story.corroborating.length > 0) && (
          <Disclosure summary="Scoring & sources">
            {story.scores && (
              <div className="mb-3">
                <p className="mb-1.5 text-[12px] text-ink-3">Editorial heuristics from Gemini (1–5). Not probabilities.</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
                  {Object.entries(story.scores).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2 border-b border-rule/70 py-0.5">
                      <dt className="text-ink-3">{SCORE_LABEL[k] ?? k}</dt>
                      <dd className="font-medium tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {story.corroborating.length > 0 && (
              <ul className="space-y-1 text-[13px]">
                {story.corroborating.map((c) => (
                  <li key={c.url}>
                    <ExternalLink href={c.url} className="text-ink-2">{c.publisher}{c.headline ? ` — ${c.headline}` : ""}</ExternalLink>
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        )}
      </div>
    </article>
  );
}

const SCORE_LABEL: Record<string, string> = {
  relevance: "Relevance",
  consequence: "Consequence",
  novelty: "Novelty",
  evidence: "Evidence",
  underReported: "Under-reported",
  counterintuitive: "Counterintuitive",
  connection: "Connection",
  noise: "Noise (lower is better)",
};

function TopicSelect({ story }: { story: EditionStory }) {
  const { run } = useDispatch();
  return (
    <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
      Topic
      <Select
        className="h-8 w-auto py-0 text-[13px]"
        value={story.topic}
        onChange={(e) => run("editStory", { storyId: story.id, baseVersion: story.version, patch: { topic: e.target.value as TopicId } })}
      >
        {TOPIC_IDS.map((t) => (
          <option key={t} value={t}>{TOPICS[t]}</option>
        ))}
      </Select>
    </label>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  if (state === "idle") return null;
  const map: Record<Exclude<SaveState, "idle">, { text: string; cls: string }> = {
    dirty: { text: "Unsaved changes", cls: "text-ink-3" },
    saving: { text: "Saving…", cls: "text-ink-3" },
    saved: { text: "Saved", cls: "text-ok" },
    error: { text: "Couldn't save", cls: "text-bad" },
    conflict: { text: "Conflict — choose a version", cls: "text-warn" },
  };
  const m = map[state];
  return (
    <span role="status" className={clsx("inline-flex items-center gap-2 text-[12px] font-medium", m.cls)}>
      {m.text}
      {state === "error" && (
        <>
          <span className="sr-only">{error}</span>
          <button className="underline" onClick={onRetry} title={error ?? undefined}>Retry</button>
        </>
      )}
    </span>
  );
}
