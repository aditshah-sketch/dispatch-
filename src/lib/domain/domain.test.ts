import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./url";
import { clusterEvents, compareEvents, eventFeatures } from "./clustering";
import { checkAgainstHistory, refsFromPreviousEditions, type CoveredRef } from "./history";
import { checkCommentary, repairSelection, validateSelection, type SelectionCandidate } from "./selection";
import {
  approvalIsValid,
  confirmEdition,
  contentHash,
  editStory,
  removeStory,
  setStoryReview,
  swapStory,
  type FinalisationContext,
} from "./edition";
import { currentPublishDate, milestonesFor, zonedTimeToUtc } from "./schedule";
import { extractAmounts, splitSentences } from "./text";
import type { Candidate, Edition, EditionStory } from "./types";
import type { TopicId } from "./topics";

const at = { actor: "owner", now: new Date("2026-10-14T10:00:00Z") };
const ready: FinalisationContext = { eligibleRecipients: 5, sendingReady: true, dailyLimit: 500 };

function story(i: number, topic: TopicId, extra: Partial<EditionStory> = {}): EditionStory {
  return {
    id: `s${i}`, articleId: `a${i}`, position: i, headline: `Headline ${i}`, publisher: "Pub", url: `https://example.com/${i}`,
    publishedAt: null, topic, commentary: "First sentence here. Second sentence here.", commentaryOrigin: "ai",
    rationale: "", rationaleOrigin: "ai", scores: null, warnings: [], corroborating: [], reviewStatus: "PENDING",
    version: 1, styleGuideVersion: 1, clusterId: `c${i}`, historyNote: null, ...extra,
  };
}

function edition(n = 9): Edition {
  const topics: TopicId[] = ["funding", "policy", "fintech", "commerce", "ai_deeptech", "exits", "governance", "enterprise", "health_edu", "climate_mobility"];
  return {
    id: "ed1", publishDate: "2026-10-15", issueNumber: 1, subject: "This week", intro: "", status: "IN_REVIEW", revision: 1,
    stories: Array.from({ length: n }, (_, i) => story(i + 1, topics[i])), approval: null, generatedBy: "ai",
    draftNotes: [], lockVersion: 1, updatedAt: at.now.toISOString(),
  };
}

function confirmNow(ed: Edition) {
  return confirmEdition(ed, { revision: ed.revision, contentHash: contentHash(ed), sendNow: false, sendAt: "2026-10-15T03:30:00Z", channel: "dashboard", sender: "me@example.com" }, ready, at);
}

describe("URL normalisation", () => {
  it("strips tracking params but keeps identifying ones", () => {
    expect(normalizeUrl("https://www.Inc42.com/buzz/story/?utm_source=x&utm_medium=rss&id=42#top")).toBe("inc42.com/buzz/story?id=42");
    expect(normalizeUrl("http://inc42.com/buzz/story")).toBe(normalizeUrl("https://www.inc42.com/buzz/story/?fbclid=abc"));
    expect(normalizeUrl("https://x.com/a?id=1")).not.toBe(normalizeUrl("https://x.com/a?id=2"));
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("event clustering", () => {
  it("groups different publishers covering the same funding round", () => {
    const clusters = clusterEvents([
      { id: "1", headline: "Kirana Cloud raises $18 million Series B to digitise wholesale credit", publishedAt: "2026-10-12T05:00:00Z" },
      { id: "2", headline: "Kirana Cloud bags $18 mn in Series B led by Northbridge", publishedAt: "2026-10-12T09:00:00Z" },
      { id: "3", headline: "RBI tightens digital lending norms for fintech partners", publishedAt: "2026-10-12T09:00:00Z" },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.memberIds.includes("1"))!.memberIds.sort()).toEqual(["1", "2"]);
  });

  it("keeps different developments about one company separate", () => {
    const m = compareEvents(
      eventFeatures({ headline: "PaySetu raises $30 million to expand UPI credit", publishedAt: "2026-10-01T00:00:00Z" }),
      eventFeatures({ headline: "PaySetu lays off 120 employees in collections unit", publishedAt: "2026-10-13T00:00:00Z" }),
    );
    expect(m.same).toBe(false);
    expect(m.sharedEntity).toBe("paysetu");
  });

  it("parses amounts consistently", () => {
    expect(extractAmounts("raises $18 million")).toEqual(["usd18m"]);
    expect(extractAmounts("bags $18 mn")).toEqual(["usd18m"]);
    expect(extractAmounts("Rs 3,000 crore IPO")).toEqual(["inr3000cr"]);
  });
});

describe("previous-edition coverage", () => {
  const refs: CoveredRef[] = [
    { editionId: "e1", publishDate: "2026-10-08", normalizedUrl: "example.com/volt", headline: "Volt Rides cuts scooter prices 12% as EV subsidy ends" },
    { editionId: "e2", publishDate: "2026-10-01", normalizedUrl: "example.com/paysetu", headline: "PaySetu raises $30 million to expand UPI credit" },
  ];

  it("excludes the same article and the same development", () => {
    expect(checkAgainstHistory({ normalizedUrl: "example.com/volt", headline: "x" }, refs).status).toBe("EXCLUDED");
    expect(
      checkAgainstHistory({ normalizedUrl: "other.com/volt-prices", headline: "EV maker Volt Rides slashes scooter prices 12% after subsidy lapse" }, refs).status,
    ).toBe("EXCLUDED");
  });

  it("allows a genuinely new development for a covered company, flagged for review", () => {
    const v = checkAgainstHistory({ normalizedUrl: "x.com/layoffs", headline: "PaySetu lays off 120 in collections unit" }, refs);
    expect(v.status).toBe("FLAGGED");
  });

  it("flags rather than excludes a later milestone of the same kind of event", () => {
    const v = checkAgainstHistory(
      { normalizedUrl: "x.com/drhp", headline: "Logistics firm Shipkart files DRHP for ₹3,000 crore IPO" },
      [{ editionId: "e3", publishDate: "2026-09-24", normalizedUrl: "x.com/bankers", headline: "Shipkart picks bankers for IPO" }],
    );
    expect(v.status).toBe("FLAGGED");
  });

  it("uses only the previous four published editions", () => {
    const many: CoveredRef[] = ["09-10", "09-17", "09-24", "10-01", "10-08"].map((d, i) => ({
      editionId: `e${i}`, publishDate: `2026-${d}`, normalizedUrl: `x/${i}`, headline: `h${i}`,
    }));
    const { editions } = refsFromPreviousEditions(many, "2026-10-15");
    expect(editions).toEqual(["e4", "e3", "e2", "e1"]);
    expect(refsFromPreviousEditions(many.slice(0, 2), "2026-10-15").editions).toHaveLength(2);
  });
});

describe("selection validation", () => {
  const cands = new Map<string, SelectionCandidate>(
    ["funding", "policy", "fintech", "commerce", "ai_deeptech", "exits", "governance", "enterprise", "funding", "funding", "funding"].map(
      (t, i) => [`a${i}`, { articleId: `a${i}`, clusterId: `c${i}`, topic: t as TopicId, score: 5 - i * 0.1 }],
    ),
  );

  it("rejects unknown IDs, bad counts and narrow topics", () => {
    const issues = validateSelection([{ articleId: "a0" }, { articleId: "ghost" }], cands);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["UNKNOWN_ID", "COUNT", "TOPICS"]));
  });

  it("accepts a valid 9-story, multi-topic selection", () => {
    const sel = [...Array(9).keys()].map((i) => ({ articleId: `a${i}` }));
    expect(validateSelection(sel, cands)).toEqual([]);
  });

  it("rejects two stories from one event cluster", () => {
    const local = new Map(cands);
    local.set("a1", { ...local.get("a1")!, clusterId: "c0" });
    const sel = [...Array(9).keys()].map((i) => ({ articleId: `a${i}` }));
    expect(validateSelection(sel, local).map((i) => i.code)).toContain("DUPLICATE_EVENT");
  });

  it("repairs deterministically without inventing candidates", () => {
    const { articleIds } = repairSelection([{ articleId: "ghost" }, { articleId: "a8" }, { articleId: "a9" }, { articleId: "a10" }], cands);
    expect(articleIds.every((id) => cands.has(id))).toBe(true);
    expect(validateSelection(articleIds.map((articleId) => ({ articleId })), cands)).toEqual([]);
  });
});

describe("commentary checks", () => {
  const evidence = "Kirana Cloud raised $18 million in a Series B round led by Northbridge Capital, the company said.";
  it("accepts supported 2–3 sentence commentary", () => {
    expect(checkCommentary("Kirana Cloud raised $18 million, the company said. The interesting part is credit, not software.", evidence).errors).toEqual([]);
  });
  it("rejects invented amounts and quotes", () => {
    const r = checkCommentary("Kirana Cloud raised $25 million. The CEO said “we will dominate every district in India”.", evidence);
    expect(r.errors.length).toBe(2);
  });
  it("splits sentences without breaking on decimals or Rs.", () => {
    expect(splitSentences("It raised Rs. 4.5 crore. That matters.")).toHaveLength(2);
  });
});

describe("edition approval rules", () => {
  it("story approval alone never schedules the edition", () => {
    let ed = edition();
    for (const s of ed.stories) {
      const r = setStoryReview(ed, { storyId: s.id, approved: true }, at);
      if (!r.ok) throw new Error(r.error.message);
      ed = r.edition;
    }
    expect(ed.status).toBe("IN_REVIEW");
    expect(ed.approval).toBeNull();
    expect(approvalIsValid(ed)).toBe(false);
  });

  it("final approval is bound to a revision and approves remaining stories", () => {
    const r = confirmNow(edition());
    if (!r.ok) throw new Error(r.error.message);
    expect(r.edition.status).toBe("SCHEDULED");
    expect(r.edition.approval!.revision).toBe(1);
    expect(r.edition.stories.every((s) => s.reviewStatus === "APPROVED")).toBe(true);
    expect(approvalIsValid(r.edition)).toBe(true);
  });

  it("rejects confirmation of a stale revision", () => {
    const ed = edition();
    const r = confirmEdition(ed, { revision: 0, contentHash: "old", sendNow: true, sendAt: null, channel: "telegram", sender: null }, ready, at);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("STALE");
  });

  it("editing an approved draft revokes approval and requires reconfirmation", () => {
    const confirmed = confirmNow(edition());
    if (!confirmed.ok) throw new Error();
    const edited = editStory(confirmed.edition, { storyId: "s3", baseVersion: 1, patch: { commentary: "New words. Still two sentences." } }, at);
    if (!edited.ok) throw new Error(edited.error.message);
    expect(edited.edition.status).toBe("IN_REVIEW");
    expect(edited.edition.approval!.revokedAt).not.toBeNull();
    expect(approvalIsValid(edited.edition)).toBe(false);
    expect(edited.edition.revision).toBe(2);
    expect(edited.events.map((e) => e.action)).toContain("approval.revoked");
  });

  it("detects concurrent edits instead of overwriting", () => {
    const ed = edition();
    const first = editStory(ed, { storyId: "s1", baseVersion: 1, patch: { commentary: "Tab A. Wrote this." } }, at);
    if (!first.ok) throw new Error();
    const second = editStory(first.edition, { storyId: "s1", baseVersion: 1, patch: { commentary: "Tab B. Wrote this." } }, at);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");
  });

  it("editing one field preserves the editor's other wording", () => {
    const ed = edition();
    const r1 = editStory(ed, { storyId: "s1", baseVersion: 1, patch: { commentary: "Shreya's words. Exactly these." } }, at);
    if (!r1.ok) throw new Error();
    const r2 = editStory(r1.edition, { storyId: "s1", baseVersion: 2, patch: { topic: "policy" } }, at);
    if (!r2.ok) throw new Error();
    expect(r2.edition.stories[0].commentary).toBe("Shreya's words. Exactly these.");
  });

  it("removal does not silently insert a replacement and blocks confirmation", () => {
    const r = removeStory(edition(8), { storyId: "s2" }, at);
    if (!r.ok) throw new Error();
    expect(r.edition.stories).toHaveLength(7);
    const c = confirmNow(r.edition);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe("BLOCKED");
  });

  it("swap revalidates event duplication", () => {
    const ed = edition();
    const dup: Candidate = {
      articleId: "z", headline: "Dup", publisher: "P", url: "https://e.com/z", publishedAt: null, topic: "policy",
      clusterId: "c1", rationale: "", rationaleOrigin: "rules", score: 3, scores: null, warnings: [], corroborating: [], historyNote: null,
    };
    expect(swapStory(ed, { storyId: "s5", candidate: dup }, at).ok).toBe(false);
    const ok = swapStory(ed, { storyId: "s5", candidate: { ...dup, clusterId: "cz" } }, at);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.edition.stories.find((s) => s.position === 5)!.articleId).toBe("z");
  });

  it("a passed send time is never silently converted to an immediate send", () => {
    const ed = edition();
    const r = confirmEdition(ed, { revision: 1, contentHash: contentHash(ed), sendNow: false, sendAt: "2026-10-14T09:00:00Z", channel: "dashboard", sender: null }, ready, at);
    expect(r.ok).toBe(false);
  });

  it("blocks when recipients exceed the account's daily limit", () => {
    const ed = edition();
    const r = confirmEdition(ed, { revision: 1, contentHash: contentHash(ed), sendNow: true, sendAt: null, channel: "dashboard", sender: null }, { ...ready, eligibleRecipients: 2200 }, at);
    expect(r.ok).toBe(false);
  });
});

describe("schedule", () => {
  it("computes Asia/Kolkata milestones", () => {
    expect(currentPublishDate(new Date("2026-10-12T06:00:00Z"))).toBe("2026-10-15");
    expect(currentPublishDate(new Date("2026-10-15T10:00:00Z"))).toBe("2026-10-15"); // Thu 3:30 PM IST
    expect(currentPublishDate(new Date("2026-10-15T20:00:00Z"))).toBe("2026-10-22"); // Fri 1:30 AM IST
    const m = milestonesFor("2026-10-15");
    expect(m.reminderAt).toBe("2026-10-14T16:30:00.000Z"); // Wed 10 PM IST
    expect(m.sendAt).toBe("2026-10-15T03:30:00.000Z"); // Thu 9 AM IST
    expect(m.draftAt).toBe("2026-10-14T09:30:00.000Z");
    expect(zonedTimeToUtc("2026-03-08", "09:00", "America/New_York").toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("entity extraction", () => {
  it("never treats amounts or units as companies", async () => {
    const { extractEntities } = await import("./text");
    expect(extractEntities("Fireside leads Rs 110 Cr Series B round in Beyond Appliances")).toEqual(["fireside", "beyond appliances"]);
    const m = compareEvents(
      eventFeatures({ headline: "Fireside leads Rs 110 Cr Series B round in Beyond Appliances", publishedAt: "2026-10-12T00:00:00Z" }),
      eventFeatures({ headline: "Exclusive: Gramiyaa raises fresh capital in Series A round at Rs 110 Cr valuation", publishedAt: "2026-10-13T00:00:00Z" }),
    );
    expect(m.same).toBe(false);
  });
});
