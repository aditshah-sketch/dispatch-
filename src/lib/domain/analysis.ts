// Deterministic eligibility analysis over a week's collected articles.
// Stage 1 of the editorial pipeline (before any Gemini call) and the source of
// the Articles screen's status labels. Shared by preview and server.

import { clusterEvents } from "./clustering";
import { topicImpact } from "./edition";
import { checkAgainstHistory, type CoveredRef, type HistoryVerdict } from "./history";
import { classifyTopicByRules, topicLabel, type TopicId } from "./topics";
import type { Article, Candidate, Edition, SourceRef } from "./types";

export type ArticleStatus =
  | "in_draft"
  | "eligible"
  | "duplicate" // exact duplicate (same URL or same text) of another article
  | "same_event" // corroborating coverage of an event represented by another article
  | "covered" // already covered in one of the previous published editions
  | "out_of_window"; // published before this edition's collection window

export interface AnalyzedArticle {
  article: Article;
  status: ArticleStatus;
  reason: string | null;
  clusterId: string | null;
  clusterSize: number;
  history: HistoryVerdict;
  draftPosition: number | null;
  topic: TopicId;
  evidenceRank: number;
}

export interface AnalysisResult {
  rows: AnalyzedArticle[];
  candidates: Candidate[];
  clusterOf: Map<string, string>;
  counts: {
    total: number;
    eligible: number;
    duplicates: number;
    sameEvent: number;
    eventsWithMultipleSources: number;
    covered: number;
    flagged: number;
    outOfWindow: number;
  };
}

export function evidenceRank(a: Article): number {
  const textLen = (a.extractedText ?? "").length;
  const descLen = (a.description ?? "").length;
  let rank = Math.min(textLen, 6000) / 1000 + Math.min(descLen, 400) / 200;
  if (a.extractionStatus === "EXTRACTED") rank += 2;
  if (a.extractionStatus === "BLOCKED" || a.extractionStatus === "FAILED") rank -= 1;
  if (a.provenance === "rss") rank += 0.25; // primary publisher feed beats aggregator copy
  return rank;
}

const NOISE = /\b(award|awards|webinar|sponsored|partner content|brand ?story|in association with|top \d+|listicle|hiring now|wishes|celebrat\w+)\b/i;

// Transparent heuristic used when Gemini is unavailable (or to order
// alternatives). It is an editorial aid, not a probability.
export function ruleScore(a: Article, clusterSize: number, now: number): number {
  let s = 2.5;
  s += Math.min(evidenceRank(a), 6) * 0.25;
  s += Math.min(clusterSize - 1, 3) * 0.35; // corroborated → consequential
  if (a.publishedAt) {
    const ageDays = (now - Date.parse(a.publishedAt)) / 86_400_000;
    s -= Math.max(0, ageDays - 2) * 0.12;
  }
  if (NOISE.test(`${a.headline} ${a.description ?? ""}`)) s -= 1.5;
  return Math.round(Math.max(0, Math.min(5, s)) * 10) / 10;
}

export function evidenceNotesFor(a: Article): string[] {
  const notes = [...a.evidenceNotes];
  const len = (a.extractedText ?? "").length;
  if (!a.extractedText && (a.description ?? "").length < 160) notes.push("Only a headline and short summary are available");
  else if (a.extractionStatus === "BLOCKED") notes.push("Full article is paywalled or blocked; based on the public summary");
  else if (a.extractionStatus === "FAILED") notes.push("Full article could not be retrieved; based on the feed summary");
  else if (len > 0 && len < 300) notes.push("Retrieved article text is very short");
  if (!a.publishedAt) notes.push("Publication date unknown");
  return [...new Set(notes)];
}

export function analyzeArticles(
  articles: Article[],
  opts: {
    refs: CoveredRef[];
    windowStart: string | null;
    edition: Pick<Edition, "stories"> | null;
    now: Date;
  },
): AnalysisResult {
  const rows = new Map<string, AnalyzedArticle>();
  const draftPos = new Map((opts.edition?.stories ?? []).map((s) => [s.articleId, s.position]));
  const ranked = [...articles].sort((a, b) => evidenceRank(b) - evidenceRank(a));

  const base = (a: Article): AnalyzedArticle => ({
    article: a,
    status: "eligible",
    reason: null,
    clusterId: null,
    clusterSize: 1,
    history: { status: "CLEAR" },
    draftPosition: draftPos.get(a.id) ?? null,
    topic: a.topic ?? classifyTopicByRules(`${a.headline} ${a.description ?? ""}`),
    evidenceRank: evidenceRank(a),
  });

  // 1. Exact duplicates — same normalised URL or same content fingerprint.
  const byUrl = new Map<string, Article>();
  const byPrint = new Map<string, Article>();
  for (const a of ranked) {
    const row = base(a);
    const twin = byUrl.get(a.normalizedUrl) ?? (a.fingerprint ? byPrint.get(a.fingerprint) : undefined);
    if (twin && row.draftPosition == null) {
      row.status = "duplicate";
      row.reason = `Duplicate of “${twin.headline}” (${twin.publisher})`;
    } else {
      byUrl.set(a.normalizedUrl, a);
      if (a.fingerprint) byPrint.set(a.fingerprint, a);
    }
    rows.set(a.id, row);
  }

  // 2. Collection window.
  const windowStart = opts.windowStart ? Date.parse(opts.windowStart) : null;
  for (const row of rows.values()) {
    if (row.status !== "eligible" || row.draftPosition != null) continue;
    const p = row.article.publishedAt ? Date.parse(row.article.publishedAt) : null;
    if (windowStart && p != null && p < windowStart) {
      row.status = "out_of_window";
      row.reason = "Published before this edition's collection window";
    }
  }

  // 3. Previous-four-edition coverage.
  let flagged = 0;
  for (const row of rows.values()) {
    if (row.status !== "eligible") continue;
    row.history = checkAgainstHistory(row.article, opts.refs);
    if (row.history.status === "EXCLUDED" && row.draftPosition == null) {
      row.status = "covered";
      row.reason = row.history.reason;
    } else if (row.history.status === "FLAGGED") flagged++;
  }

  // 4. Event clusters among the remaining articles.
  const live = [...rows.values()].filter((r) => r.status === "eligible");
  const clusters = clusterEvents(
    live.map((r) => ({
      id: r.article.id,
      headline: r.article.headline,
      description: r.article.description,
      publishedAt: r.article.publishedAt,
      // An article already placed in the draft stays the event's representative.
      evidenceRank: r.evidenceRank + (r.draftPosition != null ? 100 : 0),
    })),
  );
  const clusterOf = new Map<string, string>();
  let multi = 0;
  for (const c of clusters) {
    if (c.memberIds.length > 1) multi++;
    const primary = rows.get(c.primaryId)!;
    for (const id of c.memberIds) {
      const row = rows.get(id)!;
      row.clusterId = c.id;
      row.clusterSize = c.memberIds.length;
      clusterOf.set(id, c.id);
      if (id !== c.primaryId && row.draftPosition == null) {
        row.status = "same_event";
        row.reason = `Same event as “${primary.article.headline}” (${primary.article.publisher}) — kept as a corroborating source`;
      }
    }
  }

  for (const row of rows.values()) if (row.draftPosition != null) row.status = "in_draft";

  // 5. Candidates: one per event, with corroborating sources attached.
  const now = opts.now.getTime();
  const candidates: Candidate[] = clusters
    .map((c) => rows.get(c.primaryId)!)
    .map((row) => {
      const a = row.article;
      const corroborating: SourceRef[] = clusters
        .find((c) => c.primaryId === a.id)!
        .memberIds.filter((id) => id !== a.id)
        .map((id) => rows.get(id)!.article)
        .map((m) => ({ publisher: m.publisher, url: m.url, headline: m.headline }));
      const notes = evidenceNotesFor(a);
      return {
        articleId: a.id,
        headline: a.headline,
        publisher: a.publisher,
        url: a.url,
        publishedAt: a.publishedAt,
        topic: row.topic,
        clusterId: row.clusterId,
        rationale: ruleRationale(row, corroborating.length),
        rationaleOrigin: "rules" as const,
        score: ruleScore(a, row.clusterSize, now),
        scores: null,
        warnings: notes,
        corroborating,
        historyNote: row.history.status === "FLAGGED" ? row.history.reason : null,
      };
    })
    .sort((x, y) => (y.score ?? 0) - (x.score ?? 0));

  const all = [...rows.values()];
  return {
    rows: all,
    candidates,
    clusterOf,
    counts: {
      total: all.length,
      eligible: candidates.length,
      duplicates: all.filter((r) => r.status === "duplicate").length,
      sameEvent: all.filter((r) => r.status === "same_event").length,
      eventsWithMultipleSources: multi,
      covered: all.filter((r) => r.status === "covered").length,
      flagged,
      outOfWindow: all.filter((r) => r.status === "out_of_window").length,
    },
  };
}

function ruleRationale(row: AnalyzedArticle, corroboration: number): string {
  const parts: string[] = [];
  parts.push(corroboration > 0 ? `Reported by ${corroboration + 1} outlets` : "Single-source report");
  if (row.article.extractionStatus === "EXTRACTED") parts.push("full text available");
  else parts.push("summary only");
  parts.push(topicLabel(row.topic).toLowerCase());
  return `${parts.join(" · ")}.`;
}

// Eligible replacements for a story, with the topic-coverage implication.
export function alternativesFor(
  edition: Edition,
  storyId: string,
  candidates: Candidate[],
  limit = 5,
): Array<{ candidate: Candidate; impact: string; sameTopic: boolean }> {
  const story = edition.stories.find((s) => s.id === storyId);
  if (!story) return [];
  const others = edition.stories.filter((s) => s.id !== storyId);
  const usedArticles = new Set(edition.stories.map((s) => s.articleId));
  const usedClusters = new Set(others.map((s) => s.clusterId).filter(Boolean));
  return candidates
    .filter((c) => !usedArticles.has(c.articleId) && !(c.clusterId && usedClusters.has(c.clusterId)))
    .map((c) => ({
      candidate: c,
      sameTopic: c.topic === story.topic,
      impact: topicImpact(edition.stories.map((s) => s.topic), [...others.map((s) => s.topic), c.topic]),
    }))
    .sort((a, b) => Number(b.sameTopic) - Number(a.sameTopic) || (b.candidate.score ?? 0) - (a.candidate.score ?? 0))
    .slice(0, limit);
}
