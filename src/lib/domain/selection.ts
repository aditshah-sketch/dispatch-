import { countsTowardDiversity, distinctTopics, type TopicId } from "./topics";
import { extractAmounts, normalizeText, splitSentences } from "./text";

export const MIN_STORIES = 8;
export const MAX_STORIES = 10;
export const MIN_TOPICS = 3;

export interface SelectionCandidate {
  articleId: string;
  clusterId: string | null;
  topic: TopicId;
  score: number | null;
  excludedReason?: string | null; // e.g. previously covered — never selectable
}

export interface SelectionItem {
  articleId: string;
  topic?: string;
}

export interface SelectionIssue {
  code: "UNKNOWN_ID" | "DUPLICATE_ID" | "DUPLICATE_EVENT" | "PREVIOUSLY_COVERED" | "COUNT" | "TOPICS" | "BAD_TOPIC";
  message: string;
  articleId?: string;
}

export function validateSelection(
  selection: SelectionItem[],
  candidates: Map<string, SelectionCandidate>,
  opts: { min?: number; max?: number; minTopics?: number } = {},
): SelectionIssue[] {
  const min = opts.min ?? MIN_STORIES;
  const max = opts.max ?? MAX_STORIES;
  const minTopics = opts.minTopics ?? MIN_TOPICS;
  const issues: SelectionIssue[] = [];
  const seen = new Set<string>();
  const clusters = new Map<string, string>();
  const topics: TopicId[] = [];

  for (const item of selection) {
    const c = candidates.get(item.articleId);
    if (!c) {
      issues.push({ code: "UNKNOWN_ID", articleId: item.articleId, message: `Article ${item.articleId} is not in the candidate set` });
      continue;
    }
    if (seen.has(item.articleId)) {
      issues.push({ code: "DUPLICATE_ID", articleId: item.articleId, message: `Article ${item.articleId} was selected twice` });
      continue;
    }
    seen.add(item.articleId);
    if (c.excludedReason) {
      issues.push({ code: "PREVIOUSLY_COVERED", articleId: item.articleId, message: c.excludedReason });
    }
    if (c.clusterId) {
      const prior = clusters.get(c.clusterId);
      if (prior) {
        issues.push({
          code: "DUPLICATE_EVENT",
          articleId: item.articleId,
          message: `Article ${item.articleId} covers the same event as ${prior}`,
        });
      } else clusters.set(c.clusterId, item.articleId);
    }
    topics.push(c.topic);
  }

  const valid = selection.filter((s) => candidates.has(s.articleId)).length;
  if (valid < min || valid > max) {
    issues.push({ code: "COUNT", message: `Selected ${valid} stories; an edition needs ${min}–${max}` });
  }
  const distinct = distinctTopics(topics);
  if (distinct.length < minTopics) {
    issues.push({
      code: "TOPICS",
      message: `Selection spans ${distinct.length} substantive topic${distinct.length === 1 ? "" : "s"}; at least ${minTopics} are required`,
    });
  }
  return issues;
}

// Deterministic repair after AI selection fails validation: keep the valid,
// unique-event picks in the model's order, then fill remaining slots by score,
// preferring topics that are not yet represented. Never invents candidates.
export function repairSelection(
  selection: SelectionItem[],
  candidates: Map<string, SelectionCandidate>,
  opts: { target?: number; max?: number; minTopics?: number } = {},
): { articleIds: string[]; filledByRules: string[] } {
  const target = opts.target ?? 9;
  const max = opts.max ?? MAX_STORIES;
  const minTopics = opts.minTopics ?? MIN_TOPICS;
  const chosen: string[] = [];
  const clusters = new Set<string>();
  const accept = (id: string) => {
    const c = candidates.get(id);
    if (!c || c.excludedReason || chosen.includes(id)) return false;
    if (c.clusterId && clusters.has(c.clusterId)) return false;
    chosen.push(id);
    if (c.clusterId) clusters.add(c.clusterId);
    return true;
  };
  for (const s of selection) if (chosen.length < max) accept(s.articleId);
  const fromModel = new Set(chosen);

  const pool = [...candidates.values()]
    .filter((c) => !c.excludedReason)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topicsOf = () => new Set(chosen.map((id) => candidates.get(id)!.topic).filter(countsTowardDiversity));

  // First satisfy topic breadth, then fill to target.
  for (const c of pool) {
    if (topicsOf().size >= minTopics || chosen.length >= max) break;
    if (countsTowardDiversity(c.topic) && !topicsOf().has(c.topic)) accept(c.articleId);
  }
  for (const c of pool) {
    if (chosen.length >= target) break;
    accept(c.articleId);
  }
  // The caller re-runs validateSelection; if eligible articles are too few or
  // too narrow, the draft is saved as incomplete rather than padded.
  return { articleIds: chosen, filledByRules: chosen.filter((id) => !fromModel.has(id)) };
}

// ---------- Commentary evidence checks ----------

export interface CommentaryCheck {
  errors: string[]; // must be fixed (AI output is rejected / repaired)
  warnings: string[]; // shown to the editor
}

export function checkCommentary(text: string, evidence: string, opts: { origin?: "ai" | "editor" } = {}): CommentaryCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    errors.push("Commentary is empty");
    return { errors, warnings };
  }
  const sentences = splitSentences(trimmed);
  const sentenceIssue =
    sentences.length < 2 || sentences.length > 3 ? `Commentary has ${sentences.length} sentence${sentences.length === 1 ? "" : "s"}; the format calls for 2–3` : null;
  if (trimmed.length > 600) errors.push("Commentary is longer than 600 characters");

  const ev = normalizeText(evidence);
  // Quotations must appear verbatim in the evidence.
  const quotes = [...trimmed.matchAll(/[“"]([^”"]{12,})[”"]/g)].map((m) => normalizeText(m[1]).trim());
  for (const q of quotes) if (!ev.includes(q)) errors.push(`Quotation not found in the source text: “${q.slice(0, 60)}”`);

  // Money amounts must be traceable to the evidence.
  const evAmounts = new Set(extractAmounts(evidence));
  for (const a of extractAmounts(trimmed)) {
    if (!evAmounts.has(a)) errors.push(`Amount “${a}” does not appear in the source text`);
  }
  // Other numbers (percentages, counts, years) — flag rather than reject;
  // they may be legitimately derived or formatted differently.
  const nums = [...trimmed.matchAll(/\b\d[\d,.]*%?/g)].map((m) => m[0].replace(/[,.]$/, "").replace(/,/g, ""));
  for (const n of nums) {
    if (!ev.replace(/,/g, "").includes(n)) warnings.push(`Number “${n}” could not be matched to the source text`);
  }

  if (sentenceIssue) (opts.origin === "editor" ? warnings : errors).push(sentenceIssue);
  return { errors, warnings: [...new Set(warnings)] };
}
