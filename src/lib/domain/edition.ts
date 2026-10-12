// Edition aggregate: pure commands shared by the preview engine (in the
// browser) and the server (persisted with optimistic locking). Every command
// returns a new edition or a typed error; nothing here performs I/O.

import { fnv1a64 } from "./text";
import { distinctTopics, topicLabel, type TopicId } from "./topics";
import { MAX_STORIES, MIN_STORIES, MIN_TOPICS } from "./selection";
import {
  FROZEN_STATUSES,
  type Approval,
  type Candidate,
  type CommandResult,
  type DomainEvent,
  type Edition,
  type EditionSnapshot,
  type EditionStory,
} from "./types";

export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export interface Actor {
  actor: string; // "owner", "telegram:owner", "system"
  now: Date;
}

// ---------- Content identity ----------

export function contentHash(ed: Pick<Edition, "subject" | "intro" | "stories">): string {
  const stories = [...ed.stories]
    .sort((a, b) => a.position - b.position)
    .map((s) => [s.articleId, s.headline, s.publisher, s.url, s.topic, s.commentary.trim()]);
  return fnv1a64(JSON.stringify([ed.subject.trim(), ed.intro.trim(), stories]));
}

export function snapshotOf(ed: Edition): EditionSnapshot {
  return {
    editionId: ed.id,
    publishDate: ed.publishDate,
    issueNumber: ed.issueNumber,
    revision: ed.revision,
    contentHash: contentHash(ed),
    subject: ed.subject,
    intro: ed.intro,
    stories: [...ed.stories]
      .sort((a, b) => a.position - b.position)
      .map(({ articleId, headline, publisher, url, publishedAt, topic, commentary }) => ({
        articleId, headline, publisher, url, publishedAt, topic, commentary,
      })),
  };
}

export function isFrozen(ed: Edition): boolean {
  return FROZEN_STATUSES.includes(ed.status);
}

export function approvalIsValid(ed: Edition): boolean {
  const a = ed.approval;
  return (
    ed.status === "SCHEDULED" &&
    !!a &&
    !a.revokedAt &&
    a.revision === ed.revision &&
    a.contentHash === contentHash(ed)
  );
}

// ---------- Finalisation rules ----------

export interface FinalisationContext {
  eligibleRecipients: number;
  sendingReady: boolean;
  sendingIssue?: string;
  dailyLimit: number | null;
}

export interface FinalisationReport {
  blockers: string[];
  warnings: string[];
  topics: TopicId[];
}

export function finalisationReport(ed: Edition, ctx: FinalisationContext): FinalisationReport {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const n = ed.stories.length;
  const topics = distinctTopics(ed.stories.map((s) => s.topic));

  if (n < MIN_STORIES) blockers.push(`Add ${MIN_STORIES - n} more ${MIN_STORIES - n === 1 ? "story" : "stories"} — an edition needs ${MIN_STORIES}–${MAX_STORIES} (currently ${n}).`);
  if (n > MAX_STORIES) blockers.push(`Remove ${n - MAX_STORIES} ${n - MAX_STORIES === 1 ? "story" : "stories"} — an edition holds at most ${MAX_STORIES}.`);
  if (topics.length < MIN_TOPICS) {
    blockers.push(`Stories span ${topics.length} topic${topics.length === 1 ? "" : "s"}; at least ${MIN_TOPICS} are needed. Swap in a story from another area.`);
  }
  const empty = ed.stories.filter((s) => !s.commentary.trim());
  if (empty.length) blockers.push(`Write commentary for ${empty.map((s) => `#${s.position}`).join(", ")}.`);
  const clusters = new Map<string, number>();
  for (const s of ed.stories) {
    if (!s.clusterId) continue;
    const prior = clusters.get(s.clusterId);
    if (prior) blockers.push(`#${prior} and #${s.position} cover the same event — keep one.`);
    else clusters.set(s.clusterId, s.position);
  }
  if (!ed.subject.trim()) blockers.push("Add a subject line.");
  if (!ctx.sendingReady) blockers.push(ctx.sendingIssue ?? "Email sending is not connected.");
  if (ctx.eligibleRecipients === 0) blockers.push("There are no active subscribers to send to.");
  if (ctx.dailyLimit != null && ctx.eligibleRecipients > ctx.dailyLimit) {
    blockers.push(
      `${ctx.eligibleRecipients.toLocaleString("en-IN")} recipients exceed the sending account's configured daily limit of ${ctx.dailyLimit.toLocaleString("en-IN")}. ` +
        "Gmail cannot deliver this campaign in one morning; reduce the list or use a bulk provider (see Settings → Email).",
    );
  }

  for (const s of ed.stories) {
    if (s.historyNote) warnings.push(`#${s.position}: ${s.historyNote}`);
    for (const w of s.warnings) warnings.push(`#${s.position}: ${w}`);
    if (s.commentaryOrigin === "sample") warnings.push(`#${s.position}: commentary is prewritten sample text.`);
  }
  return { blockers, warnings, topics };
}

// ---------- Command helpers ----------

function fail(code: "CONFLICT" | "FROZEN" | "NOT_FOUND" | "INVALID" | "STALE" | "BLOCKED", message: string, current?: unknown): CommandResult {
  return { ok: false, error: { code, message, current } };
}

function editable(ed: Edition): CommandResult | null {
  if (isFrozen(ed)) {
    return fail("FROZEN", ed.status === "SENDING"
      ? "This edition is being sent. Its content is frozen so every recipient gets the same newsletter."
      : `This edition is ${ed.status.toLowerCase().replace("_", " ")} and can no longer be edited.`);
  }
  if (ed.status === "DRAFTING") return fail("INVALID", "The draft is still being generated. Try again when it finishes.");
  return null;
}

function renumber(stories: EditionStory[]): EditionStory[] {
  return [...stories].sort((a, b) => a.position - b.position).map((s, i) => ({ ...s, position: i + 1 }));
}

// Applies a content change: bumps the revision and, if the edition had been
// approved, revokes that approval so the changed content must be reconfirmed.
function withContentChange(prev: Edition, next: Edition, reason: string, at: Actor): { edition: Edition; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  let edition: Edition = {
    ...next,
    revision: prev.revision + 1,
    updatedAt: at.now.toISOString(),
    status: next.status === "COLLECTING" && next.stories.length > 0 ? "IN_REVIEW" : next.status,
  };
  if (prev.status === "SCHEDULED" && prev.approval && !prev.approval.revokedAt) {
    edition = {
      ...edition,
      status: "IN_REVIEW",
      approval: { ...prev.approval, revokedAt: at.now.toISOString(), revokedReason: reason },
    };
    events.push({
      action: "approval.revoked",
      message: `Approval for revision ${prev.revision} was withdrawn because ${reason}. Please review and confirm again.`,
      details: { revision: prev.revision },
    });
  }
  return { edition, events };
}

function findStory(ed: Edition, storyId: string): EditionStory | undefined {
  return ed.stories.find((s) => s.id === storyId);
}

// ---------- Commands ----------

export interface StoryPatch {
  commentary?: string;
  headline?: string;
  topic?: TopicId;
}

export function editStory(ed: Edition, input: { storyId: string; baseVersion: number; patch: StoryPatch }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  const story = findStory(ed, input.storyId);
  if (!story) return fail("NOT_FOUND", "That story is no longer in this edition.");
  if (story.version !== input.baseVersion) {
    return fail("CONFLICT", "This story was changed elsewhere (another tab or Telegram) after you started editing. Your text is kept — compare and save again.", story);
  }
  const p = input.patch;
  const changed: Partial<EditionStory> = {};
  if (p.commentary !== undefined && p.commentary !== story.commentary) {
    changed.commentary = p.commentary.slice(0, 1200);
    changed.commentaryOrigin = "editor";
  }
  if (p.headline !== undefined && p.headline.trim() && p.headline !== story.headline) changed.headline = p.headline.trim().slice(0, 300);
  if (p.topic !== undefined && p.topic !== story.topic) changed.topic = p.topic;
  if (!Object.keys(changed).length) return { ok: true, edition: ed, events: [] };

  const updated: EditionStory = { ...story, ...changed, version: story.version + 1 };
  const next = { ...ed, stories: ed.stories.map((s) => (s.id === story.id ? updated : s)) };
  const what = changed.commentary !== undefined ? "commentary" : changed.headline ? "headline" : "topic";
  const r = withContentChange(ed, next, `story #${story.position} ${what} was edited`, at);
  return {
    ok: true,
    edition: r.edition,
    events: [{ action: "story.edited", message: `Edited ${what} of #${story.position}`, details: { storyId: story.id, field: what } }, ...r.events],
  };
}

export function setStoryReview(
  ed: Edition,
  input: { storyId: string; expectedVersion?: number; approved: boolean },
  at: Actor,
): CommandResult {
  if (isFrozen(ed)) return fail("FROZEN", "This edition can no longer be changed.");
  const story = findStory(ed, input.storyId);
  if (!story) return fail("NOT_FOUND", "That story is no longer in this edition.");
  if (input.expectedVersion !== undefined && story.version !== input.expectedVersion) {
    return fail("STALE", "This story has changed since that message was sent. Review the current version first.", story);
  }
  const reviewStatus = input.approved ? "APPROVED" : "PENDING";
  if (story.reviewStatus === reviewStatus) return { ok: true, edition: ed, events: [] };
  // Story approval is a review marker only: it does not change content, does
  // not touch the revision, and never authorises sending.
  return {
    ok: true,
    edition: {
      ...ed,
      updatedAt: at.now.toISOString(),
      stories: ed.stories.map((s) => (s.id === story.id ? { ...s, reviewStatus } : s)),
    },
    events: [{ action: input.approved ? "story.approved" : "story.unapproved", message: `${input.approved ? "Approved" : "Reopened"} #${story.position}`, details: { storyId: story.id } }],
  };
}

export function removeStory(ed: Edition, input: { storyId: string }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  const story = findStory(ed, input.storyId);
  if (!story) return fail("NOT_FOUND", "That story is no longer in this edition.");
  const stories = renumber(ed.stories.filter((s) => s.id !== story.id));
  const r = withContentChange(ed, { ...ed, stories }, `story “${story.headline}” was removed`, at);
  const note =
    stories.length < MIN_STORIES
      ? ` The edition now has ${stories.length} stories; add ${MIN_STORIES - stories.length} before final confirmation.`
      : "";
  return {
    ok: true,
    edition: r.edition,
    events: [{ action: "story.removed", message: `Removed “${story.headline}”.${note}`, details: { storyId: story.id, articleId: story.articleId } }, ...r.events],
  };
}

export function storyFromCandidate(c: Candidate, position: number): EditionStory {
  return {
    id: newId("sty"),
    articleId: c.articleId,
    position,
    headline: c.headline,
    publisher: c.publisher,
    url: c.url,
    publishedAt: c.publishedAt,
    topic: c.topic,
    commentary: c.commentary ?? "",
    commentaryOrigin: c.commentary ? c.commentaryOrigin ?? "ai" : "empty",
    rationale: c.rationale,
    rationaleOrigin: c.rationaleOrigin,
    scores: c.scores,
    warnings: c.warnings,
    corroborating: c.corroborating,
    reviewStatus: "PENDING",
    version: 1,
    styleGuideVersion: null,
    clusterId: c.clusterId,
    historyNote: c.historyNote,
  };
}

function checkCandidateFits(ed: Edition, c: Candidate, ignoreStoryId?: string): string | null {
  const others = ed.stories.filter((s) => s.id !== ignoreStoryId);
  if (others.some((s) => s.articleId === c.articleId)) return "That article is already in the edition.";
  if (c.clusterId && others.some((s) => s.clusterId === c.clusterId)) {
    const dup = others.find((s) => s.clusterId === c.clusterId)!;
    return `That article covers the same event as #${dup.position} (“${dup.headline}”).`;
  }
  return null;
}

export function topicImpact(beforeTopics: TopicId[], afterTopics: TopicId[]): string {
  const b = distinctTopics(beforeTopics).length;
  const a = distinctTopics(afterTopics).length;
  if (a === b) return `Topic coverage stays at ${a}.`;
  if (a > b) return `Topic coverage rises to ${a}.`;
  return a < MIN_TOPICS ? `Topic coverage drops to ${a} — below the minimum of ${MIN_TOPICS}.` : `Topic coverage drops to ${a}.`;
}

export function swapStory(ed: Edition, input: { storyId: string; candidate: Candidate }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  const story = findStory(ed, input.storyId);
  if (!story) return fail("NOT_FOUND", "That story is no longer in this edition.");
  const problem = checkCandidateFits(ed, input.candidate, story.id);
  if (problem) return fail("INVALID", problem);

  const replacement = storyFromCandidate(input.candidate, story.position);
  const stories = ed.stories.map((s) => (s.id === story.id ? replacement : s));
  const impact = topicImpact(ed.stories.map((s) => s.topic), stories.map((s) => s.topic));
  const r = withContentChange(ed, { ...ed, stories }, `story #${story.position} was swapped`, at);
  return {
    ok: true,
    edition: r.edition,
    events: [{
      action: "story.swapped",
      message: `Swapped #${story.position}: “${story.headline}” → “${replacement.headline}”. ${impact}${replacement.commentary ? "" : " The new story needs commentary."}`,
      details: { from: story.articleId, to: replacement.articleId },
    }, ...r.events],
  };
}

export function addStory(ed: Edition, input: { candidate: Candidate }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  if (ed.stories.length >= MAX_STORIES) return fail("INVALID", `The edition already has ${MAX_STORIES} stories. Remove or swap one instead.`);
  const problem = checkCandidateFits(ed, input.candidate);
  if (problem) return fail("INVALID", problem);
  const story = storyFromCandidate(input.candidate, ed.stories.length + 1);
  const r = withContentChange(ed, { ...ed, stories: [...ed.stories, story] }, `a story was added`, at);
  return {
    ok: true,
    edition: r.edition,
    events: [{ action: "story.added", message: `Added “${story.headline}” as #${story.position}.`, details: { articleId: story.articleId } }, ...r.events],
  };
}

export function moveStory(ed: Edition, input: { storyId: string; direction: -1 | 1 }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  const sorted = [...ed.stories].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((s) => s.id === input.storyId);
  const j = i + input.direction;
  if (i < 0) return fail("NOT_FOUND", "That story is no longer in this edition.");
  if (j < 0 || j >= sorted.length) return { ok: true, edition: ed, events: [] };
  [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  const stories = sorted.map((s, k) => ({ ...s, position: k + 1 }));
  const r = withContentChange(ed, { ...ed, stories }, "the story order changed", at);
  return { ok: true, edition: r.edition, events: [{ action: "story.moved", message: "Reordered stories" }, ...r.events] };
}

export function editFraming(ed: Edition, input: { subject?: string; intro?: string }, at: Actor): CommandResult {
  const blocked = editable(ed);
  if (blocked) return blocked;
  const subject = input.subject !== undefined ? input.subject.slice(0, 200) : ed.subject;
  const intro = input.intro !== undefined ? input.intro.slice(0, 1500) : ed.intro;
  if (subject === ed.subject && intro === ed.intro) return { ok: true, edition: ed, events: [] };
  const what = subject !== ed.subject ? "the subject line" : "the introduction";
  const r = withContentChange(ed, { ...ed, subject, intro }, `${what} was edited`, at);
  return { ok: true, edition: r.edition, events: [{ action: "edition.framing", message: `Edited ${what}` }, ...r.events] };
}

export interface ConfirmInput {
  revision: number;
  contentHash: string;
  sendNow: boolean;
  sendAt: string | null; // required unless sendNow
  channel: "dashboard" | "telegram";
  sender: string | null;
}

export function confirmEdition(ed: Edition, input: ConfirmInput, ctx: FinalisationContext, at: Actor): CommandResult {
  if (isFrozen(ed)) return fail("FROZEN", "This edition can no longer be confirmed.");
  if (ed.status === "SCHEDULED" && approvalIsValid(ed)) return fail("INVALID", "This revision is already confirmed and scheduled.");
  if (ed.status !== "IN_REVIEW") return fail("INVALID", "There is no draft ready to confirm yet.");
  if (input.revision !== ed.revision || input.contentHash !== contentHash(ed)) {
    return fail("STALE", `The draft changed after this preview was prepared (you reviewed revision ${input.revision}; the current revision is ${ed.revision}). Review the current version before confirming.`);
  }
  const report = finalisationReport(ed, ctx);
  if (report.blockers.length) return fail("BLOCKED", report.blockers.join(" "), report);

  let sendAt: string;
  if (input.sendNow) sendAt = at.now.toISOString();
  else {
    if (!input.sendAt || Number.isNaN(Date.parse(input.sendAt))) return fail("INVALID", "Choose when to send.");
    if (Date.parse(input.sendAt) < at.now.getTime() + 60_000) {
      return fail("INVALID", "That send time has already passed. Choose “Send now” or a later time — nothing is sent automatically.");
    }
    sendAt = new Date(input.sendAt).toISOString();
  }

  const approval: Approval = {
    id: newId("apr"),
    revision: ed.revision,
    contentHash: contentHash(ed),
    approvedBy: at.actor,
    approvedAt: at.now.toISOString(),
    channel: input.channel,
    sendAt,
    sendNow: input.sendNow,
    recipientCount: ctx.eligibleRecipients,
    sender: input.sender,
    revokedAt: null,
    revokedReason: null,
  };
  const pending = ed.stories.filter((s) => s.reviewStatus !== "APPROVED").length;
  return {
    ok: true,
    edition: {
      ...ed,
      status: "SCHEDULED",
      approval,
      updatedAt: at.now.toISOString(),
      stories: ed.stories.map((s) => ({ ...s, reviewStatus: "APPROVED" })),
    },
    events: [{
      action: "edition.confirmed",
      message: `Confirmed revision ${ed.revision} (${ed.stories.length} stories${pending ? `, ${pending} approved with the edition` : ""}).`,
      details: { revision: ed.revision, contentHash: approval.contentHash, sendAt, sendNow: input.sendNow, channel: input.channel },
    }],
  };
}

export function revokeApproval(ed: Edition, input: { reason: string }, at: Actor): CommandResult {
  if (ed.status !== "SCHEDULED" || !ed.approval) return fail("INVALID", "There is no pending approval to withdraw.");
  return {
    ok: true,
    edition: {
      ...ed,
      status: "IN_REVIEW",
      updatedAt: at.now.toISOString(),
      approval: { ...ed.approval, revokedAt: at.now.toISOString(), revokedReason: input.reason },
    },
    events: [{ action: "approval.revoked", message: `Approval withdrawn: ${input.reason}`, details: { revision: ed.revision } }],
  };
}

export function topicSummary(stories: Pick<EditionStory, "topic">[]): Array<{ topic: TopicId; label: string; count: number }> {
  const counts = new Map<TopicId, number>();
  for (const s of stories) counts.set(s.topic, (counts.get(s.topic) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, label: topicLabel(topic), count }));
}
