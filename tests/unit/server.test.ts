import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));

import { contentHash, editStory, setStoryReview, type Actor } from "@/lib/domain/edition";
import { currentPublishDate } from "@/lib/domain/schedule";
import type { Edition, EditionStory } from "@/lib/domain/types";
import type { TopicId } from "@/lib/domain/topics";
import type { Db } from "@/lib/server/db/client";
import { parseDsn } from "@/lib/server/dsn";
import { isBlockedAddress } from "@/lib/server/net/safe-fetch";
import { ensureEdition, getEditionById, saveEdition } from "@/lib/server/repo/editions";
import { addSubscriber, enqueue, getJob } from "@/lib/server/repo/ops";
import { ensureWorkspace } from "@/lib/server/repo/settings";
import { bookCalendarAction, saveCalendarDraft } from "@/lib/server/services/calendar";
import { runSendJob } from "@/lib/server/services/delivery";
import { generateDraft } from "@/lib/server/services/drafting";
import { applyCommand } from "@/lib/server/services/editorial";
import { processFeedback } from "@/lib/server/services/feedback";
import { storeTokens } from "@/lib/server/services/google-auth";
import { runIngestion } from "@/lib/server/services/ingestion";
import { handleUpdate, sendDraft } from "@/lib/server/services/telegram-bot";
import { calendarDetailsKey } from "@/lib/client/actions";
import { fnv1a64 } from "@/lib/domain/text";
import { geminiResponse, json, makeDb, mockFetch, rss, setTestEnv } from "./helpers";
import { confirmEdition } from "@/lib/domain/edition";
import { finalisationContext } from "@/lib/server/services/editorial";

setTestEnv();

const TOPICS: TopicId[] = ["funding", "policy", "fintech", "commerce", "ai_deeptech", "exits", "governance", "enterprise", "health_edu"];

const NAMES = ["Kirana Cloud", "PaySetu", "Bhasha Labs", "Shipkart", "Mitti Labs", "Ledgerly", "Medisetu", "Padhai", "Suraksha", "Volt Rides", "Haldi Foods", "Desk Ninety"];
const EVENTS = ["opens Pune warehouse", "names new finance chief", "wins state tender", "launches credit card", "enters Indonesia", "cuts prices sharply", "files trademark suit", "signs bank partnership", "pilots drone delivery", "hires former regulator", "shuts Delhi office", "adds Marathi support"];

async function seedArticles(db: Db, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `art_seed${i}`;
    const headline = `${NAMES[i % NAMES.length]} ${EVENTS[i % EVENTS.length]}`;
    await db.query(
      `insert into articles (id, workspace_id, publisher, url, normalized_url, headline, published_at, description, extracted_text, fingerprint, extraction_status, provenance, topic)
       values ($1,'default','Pub',$2,$3,$4, now() - interval '1 day', $5, $5, $1, 'EXTRACTED', 'rss', $6)`,
      [id, `https://news.test/${i}`, `news.test/${i}`, headline, `${headline}, the company said in a statement.`, TOPICS[i % TOPICS.length]],
    );
    ids.push(id);
  }
  return ids;
}

async function seedDraft(db: Db, stories = 9): Promise<Edition> {
  await ensureWorkspace(db);
  const ids = await seedArticles(db, stories);
  const ed = await ensureEdition(db, currentPublishDate(new Date()));
  const list: EditionStory[] = ids.map((articleId, i) => ({
    id: `sty_${i}`, articleId, position: i + 1, headline: `Headline ${i}`, publisher: "Pub", url: `https://news.test/${i}`, publishedAt: null,
    topic: TOPICS[i % TOPICS.length], commentary: "It happened, the company said. Here is why it matters.", commentaryOrigin: "ai",
    rationale: "r", rationaleOrigin: "ai", scores: null, warnings: [], corroborating: [], reviewStatus: "PENDING", version: 1,
    styleGuideVersion: 1, clusterId: `c${i}`, historyNote: null,
  }));
  return saveEdition(db, ed, { ...ed, status: "IN_REVIEW", revision: 1, subject: "Subject", stories: list });
}

async function connectGoogle(db: Db, scopes: string[]) {
  await storeTokens(db, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, scopes, idToken: null }, "shreya@example.com");
}

const SEND = "https://www.googleapis.com/auth/gmail.send";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const CAL = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const at = (): Actor => ({ actor: "owner", now: new Date() });

async function confirm(db: Db, sendNow = true) {
  const ctx = await finalisationContext(db);
  const sendAt = sendNow ? null : new Date(Date.now() + 3_600_000).toISOString();
  return applyCommand(db, "owner", (ed, a) => confirmEdition(ed, { revision: ed.revision, contentHash: contentHash(ed), sendNow, sendAt, channel: "dashboard", sender: ctx.sender }, ctx, a));
}

let db: Db;
beforeEach(async () => {
  vi.unstubAllGlobals();
  db = await makeDb();
  await ensureWorkspace(db);
  await db.query(`update sources set enabled = false`);
});

describe("ingestion", () => {
  it("is idempotent and isolates a failing source (tests 3 & 11)", async () => {
    await db.query(`insert into sources (id, workspace_id, kind, name, locator) values ('s1','default','rss','Good','https://feeds.test/good'), ('s2','default','rss','Broken','https://feeds.test/broken')`);
    const items = [
      { title: "Kirana Cloud raises $18 million", link: "https://feeds.test/a?utm_source=rss" },
      { title: "RBI tightens lending norms", link: "https://feeds.test/b" },
    ];
    mockFetch([
      [/feeds\.test\/good/, () => new Response(rss(items), { headers: { "content-type": "application/rss+xml" } })],
      [/feeds\.test\/broken/, () => new Response("oops", { status: 500 })],
    ]);
    const first = await runIngestion(db, { trigger: "test" });
    const second = await runIngestion(db, { trigger: "test" });
    const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from articles`);
    expect(n).toBe(2);
    expect(first.status).toBe("PARTIAL");
    expect(second.stats.inserted).toBe(0);
    expect(second.stats.existing).toBe(2);
    const [broken] = await db.query<{ last_status: string }>(`select last_status from sources where id = 's2'`);
    expect(broken.last_status).toBe("FAILED");
  });

  it("blocks private and metadata addresses for outbound fetches", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"]) expect(isBlockedAddress(ip)).toBe(true);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });
});

describe("approval and delivery", () => {
  beforeEach(async () => {
    await connectGoogle(db, [SEND]);
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) await addSubscriber(db, e, null);
    await addSubscriber(db, "gone@example.com", null);
    await db.query(`update subscribers set status = 'UNSUBSCRIBED' where email = 'gone@example.com'`);
  });

  it("story approval alone cannot trigger publication (tests 13 & 16)", async () => {
    let ed = await seedDraft(db);
    for (const s of ed.stories) {
      const r = await applyCommand(db, "owner", (e, a) => setStoryReview(e, { storyId: s.id, approved: true }, a));
      expect(r.ok).toBe(true);
    }
    ed = (await getEditionById(db, ed.id))!;
    expect(ed.status).toBe("IN_REVIEW");
    const f = mockFetch([[/gmail/, () => json({ id: "x", threadId: "t" })]]);
    const out = await runSendJob(db, { payload: { editionId: ed.id, revision: ed.revision, approvalId: "forged" } }, { budgetMs: 10_000 });
    expect(out.kind).toBe("blocked");
    expect(f.count(/gmail/)).toBe(0);
  });

  it("sends once per approved revision even with duplicate invocations; skips suppressed (tests 14, 17, 19)", async () => {
    await seedDraft(db);
    const r = await confirm(db);
    expect(r.ok).toBe(true);
    const ed = (await getEditionById(db, r.ok ? r.data.edition.id : ""))!;
    expect(ed.status).toBe("SCHEDULED");
    const key = `send:${ed.id}:${ed.revision}`;
    const a = await enqueue(db, { kind: "SEND_CAMPAIGN", dedupeKey: key });
    expect(a.created).toBe(false); // already enqueued at confirmation
    const sent: string[] = [];
    const f = mockFetch([[/gmail\/v1\/users\/me\/messages\/send/, async (_u, init) => {
      const raw = Buffer.from(JSON.parse(String(init.body)).raw, "base64url").toString();
      sent.push(/^To: <(.+)>/m.exec(raw)![1]);
      // The others unsubscribe mid-campaign: they must be skipped.
      if (sent.length === 1) await db.query(`update subscribers set status = 'UNSUBSCRIBED' where email in ('b@example.com','c@example.com')`);
      return json({ id: `m${sent.length}`, threadId: `t${sent.length}` });
    }]]);
    const payload = { editionId: ed.id, revision: ed.revision, approvalId: ed.approval!.id };
    const [x, y] = await Promise.all([runSendJob(db, { payload }, { budgetMs: 20_000 }), runSendJob(db, { payload }, { budgetMs: 20_000 })]);
    expect([x.kind, y.kind]).toContain("done");
    await runSendJob(db, { payload }, { budgetMs: 20_000 });
    const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from campaigns`);
    expect(n).toBe(1);
    expect(sent).toEqual(["a@example.com"]);
    expect(f.count(/messages\/send/)).toBe(1);
    const statuses = await db.query<{ email: string; status: string }>(`select email, status from deliveries order by email`);
    expect(statuses.find((s) => s.email === "b@example.com")!.status).toBe("SKIPPED_UNSUBSCRIBED");
    expect(statuses.find((s) => s.email === "c@example.com")!.status).toBe("SKIPPED_UNSUBSCRIBED");
    expect(statuses.find((s) => s.email === "gone@example.com")!.status).toBe("SKIPPED_UNSUBSCRIBED");
    const final = (await getEditionById(db, ed.id))!;
    expect(final.status).toBe("SENT");
    const refs = await db.query(`select 1 from published_story_refs where edition_id = $1`, [ed.id]);
    expect(refs.length).toBe(9);
    // Raw MIME never exposes other recipients.
    expect(f.calls.every((c) => !c.body || !Buffer.from(JSON.parse(c.body).raw, "base64url").toString().includes("Bcc"))).toBe(true);
  });

  it("editing an approved draft revokes approval and cancels the scheduled send (test 15)", async () => {
    await seedDraft(db);
    const r = await confirm(db, false);
    expect(r.ok).toBe(true);
    const ed = r.ok ? r.data.edition : null!;
    const e2 = await applyCommand(db, "owner", (e, a) => editStory(e, { storyId: e.stories[0].id, baseVersion: 1, patch: { commentary: "Changed. Still two." } }, a));
    expect(e2.ok).toBe(true);
    const after = (await getEditionById(db, ed.id))!;
    expect(after.status).toBe("IN_REVIEW");
    expect(after.approval?.revokedAt).not.toBeNull();
    const [job] = await db.query<{ status: string }>(`select status from jobs where dedupe_key = $1`, [`send:${ed.id}:${ed.revision}`]);
    expect(job.status).toBe("CANCELLED");
    mockFetch([[/gmail/, () => json({ id: "x", threadId: "t" })]]);
    const out = await runSendJob(db, { payload: { editionId: ed.id, revision: ed.revision, approvalId: ed.approval!.id } }, { budgetMs: 5000 });
    expect(out.kind).toBe("blocked");
  });

  it("an ambiguous Gmail result is never blindly resent (test 18)", async () => {
    await seedDraft(db);
    const r = await confirm(db);
    const ed = r.ok ? r.data.edition : null!;
    let calls = 0;
    const f = mockFetch([[/messages\/send/, () => {
      calls++;
      if (calls === 1) throw new TypeError("socket hang up"); // request may have been accepted
      return json({ id: `m${calls}`, threadId: "t" });
    }]]);
    const payload = { editionId: ed.id, revision: ed.revision, approvalId: ed.approval!.id };
    await runSendJob(db, { payload }, { budgetMs: 20_000 });
    await runSendJob(db, { payload }, { budgetMs: 20_000 });
    const rows = await db.query<{ status: string }>(`select status from deliveries where status <> 'SKIPPED_UNSUBSCRIBED' order by email`);
    expect(rows.filter((x) => x.status === "UNKNOWN")).toHaveLength(1);
    expect(f.count(/messages\/send/)).toBe(3); // 3 recipients, each attempted exactly once
    expect((await getEditionById(db, ed.id))!.status).toBe("PARTIALLY_SENT");
  });

  it("quota errors pause the campaign without losing recipients (test 24)", async () => {
    await seedDraft(db);
    const r = await confirm(db);
    const ed = r.ok ? r.data.edition : null!;
    mockFetch([[/messages\/send/, () => json({ error: { message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, 429)]]);
    const out = await runSendJob(db, { payload: { editionId: ed.id, revision: ed.revision, approvalId: ed.approval!.id } }, { budgetMs: 10_000 });
    expect(out.kind).toBe("defer");
    const pending = await db.query(`select 1 from deliveries where status = 'PENDING'`);
    expect(pending.length).toBe(3);
  });

  it("blocks confirmation when Gmail isn't connected", async () => {
    await db.query(`delete from integration_credentials`);
    await seedDraft(db);
    const r = await confirm(db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BLOCKED");
  });
});

describe("bounce handling (test 20)", () => {
  const dsn = (recipient: string, status: string, ref: string) => ({
    mimeType: "multipart/report",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("Delivery failed").toString("base64url") } },
      { mimeType: "message/delivery-status", body: { data: Buffer.from(`Reporting-MTA: dns; mx.test\n\nFinal-Recipient: rfc822; ${recipient}\nAction: ${status.startsWith("5") ? "failed" : "delayed"}\nStatus: ${status}\nDiagnostic-Code: smtp; ${status} test`).toString("base64url") } },
      { mimeType: "text/rfc822-headers", body: { data: Buffer.from(`X-Dispatch-Ref: ${ref}\nSubject: x`).toString("base64url") } },
    ],
  });

  it("parses DSNs", () => {
    const p = parseDsn(dsn("A@Example.com", "5.1.1", "dlv_abc"));
    expect(p.recipients[0]).toMatchObject({ recipient: "a@example.com", status: "5.1.1", kind: "PERMANENT" });
    expect(p.deliveryRef).toBe("dlv_abc");
    expect(parseDsn({ mimeType: "text/plain", body: { data: Buffer.from("hello, please unsubscribe me").toString("base64url") } }).recipients).toEqual([]);
  });

  it("suppresses permanent bounces, records temporary ones, ignores unmatched", async () => {
    await connectGoogle(db, [SEND, READ]);
    await addSubscriber(db, "perm@example.com", null);
    await addSubscriber(db, "temp@example.com", null);
    await seedDraft(db);
    const r = await confirm(db);
    const ed = r.ok ? r.data.edition : null!;
    mockFetch([[/messages\/send/, () => json({ id: "m", threadId: "t" })]]);
    await runSendJob(db, { payload: { editionId: ed.id, revision: ed.revision, approvalId: ed.approval!.id } }, { budgetMs: 10_000 });
    const d = await db.query<{ id: string; email: string }>(`select id, email from deliveries`);
    const ref = (e: string) => d.find((x) => x.email === e)!.id;
    const messages: Record<string, unknown> = {
      b1: { id: "b1", threadId: "x", payload: dsn("perm@example.com", "5.1.1", ref("perm@example.com")) },
      b2: { id: "b2", threadId: "x", payload: dsn("temp@example.com", "4.2.2", ref("temp@example.com")) },
      b3: { id: "b3", threadId: "x", payload: dsn("stranger@example.com", "5.1.1", "dlv_none") },
    };
    mockFetch([
      [/messages\?/, () => json({ messages: Object.keys(messages).map((id) => ({ id, threadId: "x" })) })],
      [/messages\/b\d/, (u) => json(messages[/messages\/(b\d)/.exec(u)![1]])],
    ]);
    await processFeedback(db);
    await processFeedback(db); // reprocessing is a no-op
    const subs = await db.query<{ email: string; status: string; temp_failures: number }>(`select email, status, temp_failures from subscribers`);
    expect(subs.find((s) => s.email === "perm@example.com")!.status).toBe("BOUNCED");
    const temp = subs.find((s) => s.email === "temp@example.com")!;
    expect(temp.status).toBe("ACTIVE");
    expect(Number(temp.temp_failures)).toBe(1);
    const fb = await db.query<{ kind: string }>(`select kind from delivery_feedback order by provider_message_id`);
    expect(fb.map((x) => x.kind)).toEqual(["PERMANENT_BOUNCE", "TEMPORARY_BOUNCE", "UNMATCHED"]);
  });
});

describe("Telegram (test 21)", () => {
  it("rejects unauthorised chats, duplicate updates and stale confirmations", async () => {
    await connectGoogle(db, [SEND]);
    await addSubscriber(db, "a@example.com", null);
    await seedDraft(db);
    const sent: string[] = [];
    mockFetch([[/api\.telegram\.org/, (_u, init) => {
      sent.push(String(init.body));
      return json({ ok: true, result: { message_id: sent.length } });
    }]]);
    await sendDraft(db, "test");
    const [confirmToken] = await db.query<{ token: string }>(`select token from telegram_actions where action = 'confirm_start'`);
    // Stranger presses a button.
    await handleUpdate(db, { update_id: 1, callback_query: { id: "cq1", from: { id: 999 }, message: { message_id: 1, chat: { id: 999 } }, data: `t:${confirmToken.token}` } });
    expect((await getEditionById(db, (await ensureEdition(db, currentPublishDate(new Date()))).id))!.status).toBe("IN_REVIEW");
    // Owner opens the confirmation prompt, which creates a confirm_final token bound to revision 1.
    await handleUpdate(db, { update_id: 2, callback_query: { id: "cq2", from: { id: 4242 }, message: { message_id: 2, chat: { id: 4242 } }, data: `t:${confirmToken.token}` } });
    const [finalToken] = await db.query<{ token: string }>(`select token from telegram_actions where action = 'confirm_final'`);
    expect(finalToken).toBeDefined();
    // The draft changes after the message was sent.
    await applyCommand(db, "owner", (e, a) => editStory(e, { storyId: e.stories[0].id, baseVersion: 1, patch: { commentary: "New. Words here." } }, a));
    await handleUpdate(db, { update_id: 3, callback_query: { id: "cq3", from: { id: 4242 }, message: { message_id: 3, chat: { id: 4242 } }, data: `t:${finalToken.token}` } });
    const ed = (await ensureEdition(db, currentPublishDate(new Date())))!;
    expect(ed.status).toBe("IN_REVIEW");
    expect(ed.approval).toBeNull();
    // Redelivered update is ignored.
    const before = sent.length;
    await handleUpdate(db, { update_id: 3, callback_query: { id: "cq3", from: { id: 4242 }, message: { message_id: 3, chat: { id: 4242 } }, data: `t:${finalToken.token}` } });
    expect(sent.length).toBe(before);
  });

  it("reports a failed draft delivery truthfully (test 24)", async () => {
    await seedDraft(db);
    mockFetch([[/api\.telegram\.org/, () => json({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403)]]);
    const r = await sendDraft(db, "test");
    expect(r.ok).toBe(false);
    const [n] = await db.query<{ status: string }>(`select status from notifications where kind = 'DRAFT_DELIVERY' order by created_at desc limit 1`);
    expect(n.status).toBe("FAILED");
  });
});

describe("Calendar (tests 22 & 23)", () => {
  it("requires confirmation of the reviewed details and never duplicates events", async () => {
    await connectGoogle(db, [SEND, ...CAL]);
    const ed = await ensureEdition(db, currentPublishDate(new Date()));
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const r = await saveCalendarDraft(db, ed.id, { kind: "MEETING", storyId: null, title: "Follow-up", startAt: start, durationMinutes: 30, attendees: ["x@example.com"], agenda: "a", withMeet: true, reminderMinutes: 10 });
    if ("error" in r) throw new Error(r.error);
    let inserts = 0;
    const f = mockFetch([
      [/calendar\/v3\/calendars\/primary\/events\?/, () => {
        inserts++;
        return inserts === 1 ? json({ id: "e", htmlLink: "https://calendar.google.com/e", hangoutLink: "https://meet.google.com/abc-defg-hij" }) : json({ error: { message: "The requested identifier already exists." } }, 409);
      }],
    ]);
    // Wrong / stale details hash → nothing is created.
    const stale = await bookCalendarAction(db, r.id, "not-the-hash");
    expect(stale.ok).toBe(false);
    expect(f.count(/calendar/)).toBe(0);
    const details = { title: "Follow-up", startAt: start, durationMinutes: 30, attendees: ["x@example.com"], agenda: "a", withMeet: true, reminderMinutes: 10, timezone: "Asia/Kolkata" };
    const hash = fnv1a64(calendarDetailsKey(details));
    expect((await bookCalendarAction(db, r.id, hash)).ok).toBe(true);
    const again = await bookCalendarAction(db, r.id, hash);
    expect(again.ok).toBe(true);
    expect(f.count(/calendar/)).toBe(1);
    const [row] = await db.query<{ status: string; meet_url: string }>(`select status, meet_url from calendar_actions where id = $1`, [r.id]);
    expect(row.status).toBe("CREATED");
    expect(row.meet_url).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("approving the newsletter never books a meeting", async () => {
    await connectGoogle(db, [SEND, ...CAL]);
    await addSubscriber(db, "a@example.com", null);
    await seedDraft(db);
    const f = mockFetch([[/./, () => json({})]]);
    await confirm(db, false);
    expect(f.count(/calendar/)).toBe(0);
  });
});

describe("Gemini drafting (tests 8, 9, 10)", () => {
  function evalFor(n: number) {
    return { evaluations: Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, topic: TOPICS[i % TOPICS.length], relevance: 4, consequence: 4, novelty: 3, evidence: 4, underReported: 3, counterintuitive: 2, connection: 2, noise: 1, rationale: "Matters." })) };
  }

  it("rejects unknown IDs, repairs once, then completes deterministically", async () => {
    await connectGoogle(db, [SEND]);
    await seedArticles(db, 12);
    let call = 0;
    const f = mockFetch([[/generativelanguage/, (_u, init) => {
      call++;
      const body = String(init.body);
      if (body.includes("Evaluate each candidate")) return geminiResponse(evalFor(12));
      if (body.includes("Choose between")) return geminiResponse({ selected: [{ id: "a1", why: "x" }, { id: "a99", why: "invented" }], subject: "S", intro: "I" });
      // Commentary: echo supported text for every requested id.
      const ids = [...body.matchAll(/article id=\\"(a\d+)\\"/g)].map((m) => m[1]);
      return geminiResponse({ items: ids.map((id) => ({ id, commentary: `The company announced the move, the company said. Worth watching what follows.`, evidenceLimited: false })) });
    }]]);
    const r = await generateDraft(db, { actor: "test", replace: false });
    expect(r.ok).toBe(true);
    const ed = (await getEditionById(db, r.editionId))!;
    expect(ed.status).toBe("IN_REVIEW");
    expect(ed.stories.length).toBeGreaterThanOrEqual(8);
    expect(ed.stories.every((s) => s.articleId.startsWith("art_seed"))).toBe(true);
    expect(ed.draftNotes.join(" ")).toMatch(/deterministic rules/);
    expect(f.count(/generativelanguage/)).toBe(4); // eval + select + 1 repair + commentary — bounded
    expect(call).toBe(4);
  });

  it("invalid AI output fails cleanly without leaving the edition stuck (test 9)", async () => {
    await seedArticles(db, 10);
    const f = mockFetch([[/generativelanguage/, () => json({ candidates: [{ content: { parts: [{ text: "not json at all" }] }, finishReason: "STOP" }] })]]);
    const r = await generateDraft(db, { actor: "test", replace: false });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/isn't valid JSON/);
    expect(f.count(/generativelanguage/)).toBe(1);
    expect((await getEditionById(db, r.editionId))!.status).toBe("COLLECTING");
  });

  it("insufficient input produces an honest incomplete draft (test 10)", async () => {
    await seedArticles(db, 4);
    mockFetch([[/generativelanguage/, (_u, init) => {
      const body = String(init.body);
      if (body.includes("Evaluate each candidate")) return geminiResponse(evalFor(4));
      if (body.includes("Choose between")) return geminiResponse({ selected: [1, 2, 3, 4].map((i) => ({ id: `a${i}`, why: "ok" })), subject: "S", intro: "" });
      const ids = [...body.matchAll(/article id=\\"(a\d+)\\"/g)].map((m) => m[1]);
      return geminiResponse({ items: ids.map((id) => ({ id, commentary: "The company announced it, the company said. It matters for founders.", evidenceLimited: false })) });
    }]]);
    const r = await generateDraft(db, { actor: "test", replace: false });
    const ed = (await getEditionById(db, r.editionId))!;
    expect(ed.stories).toHaveLength(4);
    expect(ed.draftNotes[0]).toMatch(/Incomplete draft: only 4/);
  });

  it("drops commentary with invented amounts instead of publishing it", async () => {
    await seedArticles(db, 9);
    mockFetch([[/generativelanguage/, (_u, init) => {
      const body = String(init.body);
      if (body.includes("Evaluate each candidate")) return geminiResponse(evalFor(9));
      if (body.includes("Choose between")) return geminiResponse({ selected: Array.from({ length: 9 }, (_, i) => ({ id: `a${i + 1}`, why: "ok" })), subject: "S", intro: "" });
      const ids = [...body.matchAll(/article id=\\"(a\d+)\\"/g)].map((m) => m[1]);
      return geminiResponse({ items: ids.map((id) => ({ id, commentary: id === "a1" ? "The company raised $500 million, it said. Big news." : "The company announced it, the company said. It matters.", evidenceLimited: false })) });
    }]]);
    const r = await generateDraft(db, { actor: "test", replace: false });
    const ed = (await getEditionById(db, r.editionId))!;
    const bad = ed.stories.find((s) => s.articleId === "art_seed0")!;
    expect(bad.commentary).toBe("");
    expect(bad.warnings.join(" ")).toMatch(/evidence check/);
  });
});

describe("concurrency (test 12)", () => {
  it("a stale edit never silently overwrites a newer one", async () => {
    const ed = await seedDraft(db);
    const s = ed.stories[0];
    const first = await applyCommand(db, "owner", (e, a) => editStory(e, { storyId: s.id, baseVersion: 1, patch: { commentary: "Tab A wrote this. Two." } }, a));
    expect(first.ok).toBe(true);
    const second = await applyCommand(db, "owner", (e, a) => editStory(e, { storyId: s.id, baseVersion: 1, patch: { commentary: "Tab B wrote this. Two." } }, a));
    expect(second.ok).toBe(false);
    const now = (await getEditionById(db, ed.id))!;
    expect(now.stories[0].commentary).toBe("Tab A wrote this. Two.");
    void setStoryReview;
    void at;
  });

  it("job dedupe keys make duplicate cron enqueues harmless (test 17)", async () => {
    const a = await enqueue(db, { kind: "REMINDER", dedupeKey: "reminder:2026-10-15" });
    const b = await enqueue(db, { kind: "REMINDER", dedupeKey: "reminder:2026-10-15" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect((await getJob(db, a.job.id))!.id).toBe(b.job.id);
  });
});
