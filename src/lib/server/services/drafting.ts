import "server-only";
import { z } from "zod";
import { analyzeArticles, evidenceNotesFor } from "../../domain/analysis";
import { newId, storyFromCandidate } from "../../domain/edition";
import { refsFromPreviousEditions } from "../../domain/history";
import { currentPublishDate, milestonesFor } from "../../domain/schedule";
import {
  checkCommentary,
  MAX_STORIES,
  MIN_STORIES,
  MIN_TOPICS,
  repairSelection,
  validateSelection,
  type SelectionCandidate,
} from "../../domain/selection";
import { truncate } from "../../domain/text";
import { distinctTopics, TOPIC_IDS, TOPICS, type TopicId } from "../../domain/topics";
import type { Article, Candidate, Edition, EditionStory, RubricScores } from "../../domain/types";
import type { Db } from "../db/client";
import { GeminiError, generateJson, UNTRUSTED_CONTENT_RULES, type GeminiUsage } from "../providers/gemini";
import { articlesSince, getArticles, saveTopics } from "../repo/articles";
import { coveredRefs, ensureEdition, getEditionById, saveEdition } from "../repo/editions";
import { audit, markHealth } from "../repo/ops";
import { getSettings, getStyleGuide } from "../repo/settings";

const PROMPT_VERSION = "2026-10-12.1";
const MAX_EVAL_CANDIDATES = 60;
const EVAL_BATCH = 30;
const SHORTLIST = 24;

// ---------- Evidence helpers ----------

function evidenceOf(a: Article, max: number): string {
  const body = a.extractedText && a.extractedText.length > (a.description ?? "").length ? a.extractedText : a.description ?? "";
  return truncate(`${a.headline}. ${body}`.replace(/\s+/g, " "), max);
}

function articleBlock(alias: string, a: Article, c: Candidate, max: number): string {
  return [
    `<article id="${alias}">`,
    `headline: ${a.headline}`,
    `publisher: ${a.publisher}${c.corroborating.length ? ` (also reported by ${c.corroborating.map((x) => x.publisher).join(", ")})` : ""}`,
    `published: ${a.publishedAt ?? "unknown"}`,
    c.historyNote ? `history_note: ${c.historyNote}` : null,
    `evidence: ${evidenceOf(a, max)}`,
    `</article>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- Stage 3: candidate evaluation ----------

const scoreSchema = { type: "integer", minimum: 1, maximum: 5 };
const EVAL_SCHEMA = {
  type: "object",
  properties: {
    evaluations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          topic: { type: "string", enum: TOPIC_IDS },
          relevance: scoreSchema, consequence: scoreSchema, novelty: scoreSchema, evidence: scoreSchema,
          underReported: scoreSchema, counterintuitive: scoreSchema, connection: scoreSchema, noise: scoreSchema,
          rationale: { type: "string", description: "One sentence, max 200 characters, on why this matters (or doesn't) for the newsletter." },
          sameEventAs: { type: "string", description: "id of another candidate covering the same event, or empty" },
        },
        required: ["id", "topic", "relevance", "consequence", "novelty", "evidence", "underReported", "counterintuitive", "connection", "noise", "rationale"],
      },
    },
  },
  required: ["evaluations"],
};
const score = z.number().int().min(1).max(5);
const EvalZ = z.object({
  evaluations: z.array(
    z.object({
      id: z.string(),
      topic: z.enum(TOPIC_IDS as [TopicId, ...TopicId[]]),
      relevance: score, consequence: score, novelty: score, evidence: score,
      underReported: score, counterintuitive: score, connection: score, noise: score,
      rationale: z.string().max(400),
      sameEventAs: z.string().optional(),
    }),
  ),
});

function rubricTotal(s: RubricScores): number {
  // Weighted editorial heuristic (not a probability).
  const v = s.relevance * 1.4 + s.consequence * 1.3 + s.novelty + s.evidence * 0.8 + s.underReported * 1.1 + s.counterintuitive * 0.9 + s.connection * 0.6 - s.noise * 1.2;
  return Math.round((v / 8.6) * 10) / 10;
}

const EDITOR_CONTEXT = `You are assisting the editor of "The Dispatch", a weekly newsletter on the Indian startup ecosystem read by founders, operators and investors. The editor's value is judgement: spotting counterintuitive developments, under-reported stories, connections between trends, and explaining why things matter. You prepare options; the editor decides.`;

const TOPIC_GUIDE = TOPIC_IDS.map((t) => `${t} = ${TOPICS[t]}`).join("; ");

// ---------- Stage 4: selection ----------

const SELECT_SCHEMA = {
  type: "object",
  properties: {
    selected: { type: "array", items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"] } },
    subject: { type: "string", description: "Email subject line, max 80 characters, no clickbait" },
    intro: { type: "string", description: "1–2 sentence introduction connecting this week's themes. Only reference selected stories." },
  },
  required: ["selected", "subject", "intro"],
};
const SelectZ = z.object({
  selected: z.array(z.object({ id: z.string(), why: z.string().max(400) })),
  subject: z.string().max(160),
  intro: z.string().max(800),
});

// ---------- Stage 5: commentary ----------

const COMMENTARY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          commentary: { type: "string", description: "2–3 sentences. First: what happened, attributed. Then: why it matters." },
          evidenceLimited: { type: "boolean", description: "true if the evidence was too thin to say much" },
        },
        required: ["id", "commentary", "evidenceLimited"],
      },
    },
  },
  required: ["items"],
};
const CommentaryZ = z.object({ items: z.array(z.object({ id: z.string(), commentary: z.string().max(900), evidenceLimited: z.boolean() })) });

async function writeCommentary(
  items: Array<{ alias: string; article: Article; candidate: Candidate }>,
  style: { content: string; examples: string },
  repairNotes?: Map<string, string[]>,
): Promise<{ byAlias: Map<string, { commentary: string; evidenceLimited: boolean }>; usage: GeminiUsage }> {
  const system = `${EDITOR_CONTEXT}

Write commentary for each article in the editor's house style:
${style.content}
${style.examples.trim() ? `\nExamples of the editor's past writing (for tone only — never reuse their facts):\n${truncate(style.examples, 3000)}` : ""}

Rules:
- Exactly 2 or 3 sentences per article, under 75 words.
- First sentence states what was reported, with attribution ("the company said", "according to …").
- Then explain why it matters. Clearly separate reported fact from interpretation ("This suggests…", "Worth watching whether…").
- Use ONLY facts present in that article's evidence. Do not add numbers, amounts, dates, names, quotes or causes that are not in the evidence. Do not predict outcomes.
- If the evidence is thin, write a cautious 2-sentence note and set evidenceLimited to true.
${UNTRUSTED_CONTENT_RULES}`;
  const user = items
    .map(({ alias, article, candidate }) => {
      const fix = repairNotes?.get(alias);
      return `${articleBlock(alias, article, candidate, 1600)}${fix ? `\nPrevious attempt was rejected: ${fix.join("; ")}. Fix these problems.` : ""}`;
    })
    .join("\n\n");
  const r = await generateJson({ system, user: `Write commentary for these ${items.length} articles. Return one item per id.\n\n${user}`, schema: COMMENTARY_SCHEMA, validator: CommentaryZ, maxOutputTokens: 6000 });
  const byAlias = new Map<string, { commentary: string; evidenceLimited: boolean }>();
  for (const it of r.data.items) if (items.some((x) => x.alias === it.id)) byAlias.set(it.id, { commentary: it.commentary.trim(), evidenceLimited: it.evidenceLimited });
  return { byAlias, usage: r.usage };
}

// Commentary for a set of stories with evidence checks and one bounded repair.
async function commentaryWithChecks(
  items: Array<{ alias: string; article: Article; candidate: Candidate }>,
  style: { content: string; examples: string },
): Promise<Map<string, { commentary: string; warnings: string[] }>> {
  const out = new Map<string, { commentary: string; warnings: string[] }>();
  const first = await writeCommentary(items, style);
  const retry = new Map<string, string[]>();
  for (const it of items) {
    const got = first.byAlias.get(it.alias);
    if (!got) {
      retry.set(it.alias, ["No commentary was returned"]);
      continue;
    }
    const check = checkCommentary(got.commentary, evidenceOf(it.article, 20000));
    if (check.errors.length) retry.set(it.alias, check.errors);
    else out.set(it.alias, { commentary: got.commentary, warnings: [...check.warnings, ...(got.evidenceLimited ? ["Gemini flagged the evidence as thin"] : [])] });
  }
  if (retry.size) {
    const again = await writeCommentary(items.filter((i) => retry.has(i.alias)), style, retry).catch(() => null);
    for (const it of items.filter((i) => retry.has(i.alias))) {
      const got = again?.byAlias.get(it.alias);
      const check = got ? checkCommentary(got.commentary, evidenceOf(it.article, 20000)) : null;
      if (got && check && !check.errors.length) out.set(it.alias, { commentary: got.commentary, warnings: check.warnings });
      else {
        // Never keep unsupported claims: leave it for the editor, explain why.
        out.set(it.alias, { commentary: "", warnings: [`Generated commentary failed the evidence check (${(check?.errors ?? retry.get(it.alias) ?? []).join("; ")}). Please write this one.`] });
      }
    }
  }
  return out;
}

// ---------- Orchestration ----------

export interface DraftOutcome {
  ok: boolean;
  message: string;
  editionId: string;
}

export async function generateDraft(db: Db, opts: { actor: string; replace: boolean; onStage?: (s: string) => Promise<void> }): Promise<DraftOutcome> {
  const now = new Date();
  const stage = async (s: string) => opts.onStage?.(s);
  const settings = await getSettings(db);
  const publishDate = currentPublishDate(now, settings.schedule);
  const m = milestonesFor(publishDate, settings.schedule);
  let edition = await ensureEdition(db, publishDate);

  if (["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED"].includes(edition.status)) {
    return { ok: false, message: "This edition is already confirmed or sent. Withdraw the approval first to regenerate.", editionId: edition.id };
  }
  if (edition.status === "DRAFTING") return { ok: false, message: "A draft is already being generated.", editionId: edition.id };
  const hasEdits = edition.stories.some((s) => s.commentaryOrigin === "editor");
  if (edition.stories.length && !opts.replace) {
    return { ok: false, message: hasEdits ? "A draft with your edits already exists. Regenerating would replace it." : "A draft already exists.", editionId: edition.id };
  }

  const before = edition;
  const previousStatus = edition.status;
  edition = await saveEdition(db, before, { ...before, status: "DRAFTING" });

  const usage: GeminiUsage[] = [];
  const notes: string[] = [];
  try {
    // Stage 1–2: deterministic eligibility, history and event grouping.
    await stage("Filtering duplicates, old stories and previously covered events…");
    const articles = await articlesSince(db, m.collectionWindowStart);
    const { refs, editions: historyEditions } = refsFromPreviousEditions(await coveredRefs(db), publishDate);
    const analysis = analyzeArticles(articles, { refs, windowStart: m.collectionWindowStart, edition: null, now });
    const byId = new Map(articles.map((a) => [a.id, a]));
    if (historyEditions.length < 4) notes.push(`History check covered ${historyEditions.length} of 4 previous editions (only ${historyEditions.length} published so far).`);

    const pool = analysis.candidates.slice(0, MAX_EVAL_CANDIDATES);
    if (pool.length === 0) throw new DraftInputError("No eligible articles in this week's window. Run a collection or add stories manually.");
    const alias = new Map(pool.map((c, i) => [c.articleId, `a${i + 1}`]));
    const fromAlias = new Map(pool.map((c, i) => [`a${i + 1}`, c]));

    // Stage 3: evaluate candidates in batches.
    const evaluations = new Map<string, z.infer<typeof EvalZ>["evaluations"][number]>();
    for (let i = 0; i < pool.length; i += EVAL_BATCH) {
      await stage(`Gemini is evaluating candidates ${i + 1}–${Math.min(i + EVAL_BATCH, pool.length)} of ${pool.length}…`);
      const batch = pool.slice(i, i + EVAL_BATCH);
      const r = await generateJson({
        system: `${EDITOR_CONTEXT}

Evaluate each candidate article against this rubric (integers 1–5; these are editorial heuristics, not probabilities):
relevance to Indian startups; consequence; novelty; evidence quality (how well-sourced the evidence is); under-reported significance; counterintuitive insight; connection to other candidates this week; noise (promotional, repetitive or trivial — higher is worse).
Assign exactly one topic from: ${TOPIC_GUIDE}. Choose the topic from the article's actual content.
If two candidates cover the same event, set sameEventAs on the weaker one.
${UNTRUSTED_CONTENT_RULES}`,
        user: `Candidates:\n\n${batch.map((c) => articleBlock(alias.get(c.articleId)!, byId.get(c.articleId)!, c, 700)).join("\n\n")}`,
        schema: EVAL_SCHEMA,
        validator: EvalZ,
        maxOutputTokens: 8000,
      });
      usage.push(r.usage);
      for (const e of r.data.evaluations) if (fromAlias.has(e.id)) evaluations.set(e.id, e);
    }
    const unevaluated = pool.filter((c) => !evaluations.has(alias.get(c.articleId)!)).length;
    if (unevaluated) notes.push(`${unevaluated} candidates weren't scored by Gemini and kept their rule-based order.`);

    // Merge evaluations into candidates; drop Gemini-identified same-event duplicates.
    const enriched: Candidate[] = pool.map((c) => {
      const e = evaluations.get(alias.get(c.articleId)!);
      if (!e) return c;
      const scores: RubricScores = { relevance: e.relevance, consequence: e.consequence, novelty: e.novelty, evidence: e.evidence, underReported: e.underReported, counterintuitive: e.counterintuitive, connection: e.connection, noise: e.noise };
      return { ...c, topic: e.topic, scores, score: rubricTotal(scores), rationale: truncate(e.rationale, 220), rationaleOrigin: "ai" };
    });
    const mergedAway = new Set<string>();
    for (const [a, e] of evaluations) {
      const other = e.sameEventAs ? fromAlias.get(e.sameEventAs) : null;
      if (other && e.sameEventAs !== a) {
        const mine = enriched.find((c) => c.articleId === fromAlias.get(a)!.articleId)!;
        const theirs = enriched.find((c) => c.articleId === other.articleId)!;
        const loser = (mine.score ?? 0) <= (theirs.score ?? 0) ? mine : theirs;
        const winner = loser === mine ? theirs : mine;
        mergedAway.add(loser.articleId);
        winner.corroborating = [...winner.corroborating, { publisher: loser.publisher, url: loser.url, headline: loser.headline }];
        loser.clusterId = winner.clusterId;
      }
    }
    await saveTopics(db, enriched.filter((c) => evaluations.has(alias.get(c.articleId)!)).map((c) => ({ id: c.articleId, topic: c.topic, origin: "ai" as const })));

    const ranked = enriched.filter((c) => !mergedAway.has(c.articleId)).sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    const shortlist = ranked.slice(0, SHORTLIST);
    const selCandidates = new Map<string, SelectionCandidate>(ranked.map((c) => [c.articleId, { articleId: c.articleId, clusterId: c.clusterId, topic: c.topic, score: c.score }]));

    // Stage 4: batch-level selection with one bounded repair attempt.
    await stage("Gemini is choosing 8–10 stories across topics…");
    const selectionPrompt = (errors?: string[]) => ({
      system: `${EDITOR_CONTEXT}

Choose between ${MIN_STORIES} and ${MAX_STORIES} stories for this week's edition.
Requirements:
- At least ${MIN_TOPICS} different topics (the "other" topic does not count). Do not relabel topics to reach the minimum.
- No two stories about the same event.
- Prefer consequential, under-reported and counterintuitive developments over big-name announcements and promotional items.
- Prefer stories that connect to each other into a coherent week.
- If fewer than ${MIN_STORIES} candidates are worth including, return only the worthy ones — never pad.
For each pick give a one-sentence reason (max 200 characters). Write a plain, specific subject line and a 1–2 sentence intro.
${UNTRUSTED_CONTENT_RULES}`,
      user: `Shortlisted candidates (scores are 1–5 heuristics):\n\n${shortlist
        .map((c) => `${alias.get(c.articleId)} | ${c.topic} | score ${c.score} | ${c.headline} (${c.publisher}) | ${c.rationale}${c.historyNote ? ` | NOTE: ${c.historyNote}` : ""}`)
        .join("\n")}${errors ? `\n\nYour previous selection was invalid: ${errors.join("; ")}. Return a corrected selection.` : ""}`,
      schema: SELECT_SCHEMA,
      validator: SelectZ,
      maxOutputTokens: 3000,
    });

    let sel = await generateJson(selectionPrompt());
    usage.push(sel.usage);
    const toItems = (s: z.infer<typeof SelectZ>) => s.selected.map((x) => ({ articleId: fromAlias.get(x.id)?.articleId ?? `unknown:${x.id}`, why: x.why }));
    let picks = toItems(sel.data);
    let issues = validateSelection(picks, selCandidates);
    if (issues.length && ranked.length >= MIN_STORIES) {
      await stage("Selection didn't pass validation — asking Gemini to correct it…");
      sel = await generateJson(selectionPrompt(issues.map((i) => i.message.replace(/art_[a-z0-9]+/g, (id) => alias.get(id) ?? id))));
      usage.push(sel.usage);
      picks = toItems(sel.data);
      issues = validateSelection(picks, selCandidates);
    }
    let finalIds = picks.filter((p) => selCandidates.has(p.articleId)).map((p) => p.articleId);
    let ruleFilled: string[] = [];
    if (issues.length) {
      const repaired = repairSelection(picks, selCandidates);
      finalIds = repaired.articleIds;
      ruleFilled = repaired.filledByRules;
      notes.push(`Gemini's selection still had problems after one correction (${issues.map((i) => i.message).join("; ")}). The draft was completed by deterministic rules: ${ruleFilled.length} stories were added or kept by score and topic.`);
    }
    const why = new Map(picks.map((p) => [p.articleId, p.why]));

    // Stage 5: commentary with evidence checks.
    await stage(`Gemini is writing commentary for ${finalIds.length} stories…`);
    const style = await getStyleGuide(db);
    const chosen = finalIds.map((id) => ranked.find((c) => c.articleId === id)!);
    const commentary = await commentaryWithChecks(
      chosen.map((c) => ({ alias: alias.get(c.articleId)!, article: byId.get(c.articleId)!, candidate: c })),
      style,
    ).catch((e: unknown) => {
      notes.push(`Commentary generation failed (${(e as Error).message}). Stories are selected; please write commentary or retry per story.`);
      return new Map<string, { commentary: string; warnings: string[] }>();
    });

    // Stage 6: deterministic final validation and save.
    await stage("Validating the draft…");
    const stories: EditionStory[] = chosen.map((c, i) => {
      const a = byId.get(c.articleId)!;
      const com = commentary.get(alias.get(c.articleId)!);
      const base = storyFromCandidate(
        {
          ...c,
          rationale: why.get(c.articleId) ? truncate(why.get(c.articleId)!, 240) : c.rationale,
          rationaleOrigin: ruleFilled.includes(c.articleId) ? "rules" : c.rationaleOrigin,
          commentary: com?.commentary || undefined,
          commentaryOrigin: "ai",
          warnings: [...new Set([...evidenceNotesFor(a), ...(com?.warnings ?? [])])],
        },
        i + 1,
      );
      return { ...base, styleGuideVersion: style.version };
    });
    const finalIssues = validateSelection(stories.map((s) => ({ articleId: s.articleId })), selCandidates);
    if (stories.length < MIN_STORIES) {
      notes.unshift(`Incomplete draft: only ${stories.length} eligible stories were strong enough (${MIN_STORIES} needed). Nothing was invented to fill the gap — run another collection or add stories from the Articles page.`);
    }
    if (distinctTopics(stories.map((s) => s.topic)).length < MIN_TOPICS) notes.unshift("The available stories don't yet span three topics. Swap one in from another area before confirming.");
    for (const i of finalIssues) if (i.code !== "COUNT" && i.code !== "TOPICS") notes.push(i.message);

    const fresh = (await getEditionById(db, edition.id))!;
    const saved = await saveEdition(db, fresh, {
      ...fresh,
      status: "IN_REVIEW",
      revision: fresh.revision + 1,
      subject: truncate(sel.data.subject.trim() || "The Dispatch", 120),
      intro: sel.data.intro.trim(),
      stories,
      generatedBy: "ai",
      draftNotes: notes,
      approval: fresh.approval,
    });
    const tokens = usage.reduce((n, u) => n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0);
    await markHealth(db, "gemini", true);
    await audit(db, {
      actor: opts.actor,
      action: "draft.generated",
      entityType: "edition",
      entityId: saved.id,
      message: `Gemini draft generated: ${stories.length} stories, ${distinctTopics(stories.map((s) => s.topic)).length} topics (revision ${saved.revision}).`,
      details: { model: usage[0]?.model, promptVersion: PROMPT_VERSION, styleGuideVersion: style.version, calls: usage.length, tokens, candidates: pool.length },
    });
    return { ok: true, message: `Draft ready: ${stories.length} stories.`, editionId: saved.id };
  } catch (e) {
    // Preserve whatever existed before; never leave the edition stuck in DRAFTING.
    const fresh = (await getEditionById(db, edition.id))!;
    await saveEdition(db, fresh, { ...fresh, status: previousStatus });
    const msg = e instanceof GeminiError || e instanceof DraftInputError ? e.message : `Draft generation failed: ${(e as Error).message}`;
    if (e instanceof GeminiError) await markHealth(db, "gemini", false, e.message);
    await audit(db, { actor: opts.actor, action: "draft.failed", entityType: "edition", entityId: edition.id, message: msg });
    return { ok: false, message: msg, editionId: edition.id };
  }
}

export class DraftInputError extends Error {}

// Regenerates ONE story's commentary — never the whole edition.
export async function regenerateStoryCommentary(db: Db, edition: Edition, storyId: string): Promise<{ commentary: string; warnings: string[] }> {
  const story = edition.stories.find((s) => s.id === storyId);
  if (!story) throw new DraftInputError("Story not found.");
  const [article] = await getArticles(db, [story.articleId]);
  if (!article) throw new DraftInputError("The source article for this story is no longer stored.");
  const style = await getStyleGuide(db);
  const cand: Candidate = { articleId: article.id, headline: story.headline, publisher: story.publisher, url: story.url, publishedAt: story.publishedAt, topic: story.topic, clusterId: story.clusterId, rationale: story.rationale, rationaleOrigin: story.rationaleOrigin, score: null, scores: story.scores, warnings: [], corroborating: story.corroborating, historyNote: story.historyNote };
  const res = await commentaryWithChecks([{ alias: "a1", article, candidate: cand }], style);
  const got = res.get("a1")!;
  if (!got.commentary) throw new DraftInputError(got.warnings[0] ?? "Gemini couldn't produce supported commentary.");
  await markHealth(db, "gemini", true);
  return got;
}

// Neutral meeting title/agenda suggestion. Never proposes attendees.
export async function suggestMeeting(story: EditionStory): Promise<{ title: string; agenda: string }> {
  const r = await generateJson({
    system: `You help an editor plan a follow-up conversation about a news story (reporting, an interview, or an editorial discussion). Suggest a neutral meeting title (max 80 chars) and a short agenda (3–5 bullet lines starting with "- "). Do not name or suggest attendees, contacts, emails or phone numbers. Do not add facts beyond the story text.\n${UNTRUSTED_CONTENT_RULES}`,
    user: `<article id="s">\nheadline: ${story.headline}\npublisher: ${story.publisher}\nnotes: ${story.commentary}\n</article>`,
    schema: { type: "object", properties: { title: { type: "string" }, agenda: { type: "string" } }, required: ["title", "agenda"] },
    validator: z.object({ title: z.string().max(160), agenda: z.string().max(1500) }),
    maxOutputTokens: 800,
  });
  // Strip anything that looks like contact details, in case the model ignored the rule.
  const scrub = (s: string) => s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[removed]").replace(/\+?\d[\d\s-]{8,}\d/g, "[removed]");
  return { title: truncate(scrub(r.data.title), 100), agenda: scrub(r.data.agenda) };
}

export { newId };
