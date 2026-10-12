import "server-only";
import { contentHash, newId, snapshotOf } from "../../domain/edition";
import type { CoveredRef } from "../../domain/history";
import { isTopicId } from "../../domain/topics";
import type { Approval, Edition, EditionSnapshot, EditionStory } from "../../domain/types";
import { normalizeUrl } from "../../domain/url";
import { WORKSPACE_ID } from "../config";
import { iso, json, type Db } from "../db/client";

type R = Record<string, unknown>;

export class ConcurrentUpdateError extends Error {
  constructor() {
    super("The edition was changed by another request. Please retry.");
    this.name = "ConcurrentUpdateError";
  }
}

function mapStory(r: R): EditionStory {
  return {
    id: String(r.id),
    articleId: String(r.article_id),
    position: Number(r.position),
    headline: String(r.headline),
    publisher: String(r.publisher),
    url: String(r.url),
    publishedAt: iso(r.published_at),
    topic: isTopicId(r.topic) ? r.topic : "other",
    commentary: String(r.commentary ?? ""),
    commentaryOrigin: r.commentary_origin as EditionStory["commentaryOrigin"],
    rationale: String(r.rationale ?? ""),
    rationaleOrigin: r.rationale_origin as EditionStory["rationaleOrigin"],
    scores: (r.scores as EditionStory["scores"]) ?? null,
    warnings: (r.warnings as string[]) ?? [],
    corroborating: (r.corroborating as EditionStory["corroborating"]) ?? [],
    reviewStatus: r.review_status as EditionStory["reviewStatus"],
    version: Number(r.version),
    styleGuideVersion: r.style_guide_version == null ? null : Number(r.style_guide_version),
    clusterId: (r.cluster_id as string) ?? null,
    historyNote: (r.history_note as string) ?? null,
  };
}

function mapApproval(r: R | undefined): Approval | null {
  if (!r) return null;
  return {
    id: String(r.id),
    revision: Number(r.revision),
    contentHash: String(r.content_hash),
    approvedBy: String(r.approved_by),
    approvedAt: iso(r.approved_at)!,
    channel: r.channel as Approval["channel"],
    sendAt: iso(r.send_at)!,
    sendNow: !!r.send_now,
    recipientCount: Number(r.recipient_count),
    sender: (r.sender as string) ?? null,
    revokedAt: iso(r.revoked_at),
    revokedReason: (r.revoked_reason as string) ?? null,
  };
}

const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function hydrate(db: Db, r: R): Promise<Edition> {
  const stories = await db.query<R>(`select * from edition_stories where edition_id = $1 order by position`, [r.id]);
  const [approval] = await db.query<R>(`select * from approvals where edition_id = $1 order by approved_at desc limit 1`, [r.id]);
  return {
    id: String(r.id),
    publishDate: ymd(r.publish_date),
    issueNumber: r.issue_number == null ? null : Number(r.issue_number),
    subject: String(r.subject ?? ""),
    intro: String(r.intro ?? ""),
    status: r.status as Edition["status"],
    revision: Number(r.revision),
    stories: stories.map(mapStory),
    approval: mapApproval(approval),
    generatedBy: (r.generated_by as Edition["generatedBy"]) ?? null,
    draftNotes: (r.draft_notes as string[]) ?? [],
    lockVersion: Number(r.lock_version),
    updatedAt: iso(r.updated_at)!,
  };
}

export async function getEditionById(db: Db, id: string, forUpdate = false): Promise<Edition | null> {
  const [r] = await db.query<R>(`select * from editions where id = $1 and workspace_id = $2${forUpdate && db.kind === "postgres" ? " for update" : ""}`, [id, WORKSPACE_ID]);
  return r ? hydrate(db, r) : null;
}

// One edition per workspace per publish date (unique constraint).
export async function ensureEdition(db: Db, publishDate: string): Promise<Edition> {
  const [existing] = await db.query<R>(`select * from editions where workspace_id = $1 and publish_date = $2::date`, [WORKSPACE_ID, publishDate]);
  if (existing) return hydrate(db, existing);
  const [prev] = await db.query<{ n: number | null }>(
    `select max(issue_number)::int as n from editions where workspace_id = $1 and publish_date < $2::date`,
    [WORKSPACE_ID, publishDate],
  );
  await db.query(
    `insert into editions (id, workspace_id, publish_date, issue_number, status) values ($1,$2,$3::date,$4,'COLLECTING')
     on conflict (workspace_id, publish_date) do nothing`,
    [newId("ed"), WORKSPACE_ID, publishDate, prev?.n ? Number(prev.n) + 1 : null],
  );
  const [r] = await db.query<R>(`select * from editions where workspace_id = $1 and publish_date = $2::date`, [WORKSPACE_ID, publishDate]);
  return hydrate(db, r);
}

// Persists an edition aggregate with optimistic locking: the update only
// applies if nobody else saved since `prev` was loaded.
export async function saveEdition(db: Db, prev: Edition, next: Edition): Promise<Edition> {
  return db.tx(async (tx) => {
    const updated = await tx.query(
      `update editions set subject = $3, intro = $4, status = $5, revision = $6, lock_version = lock_version + 1,
         generated_by = $7, draft_notes = $8::jsonb, updated_at = now()
       where id = $1 and lock_version = $2 returning id`,
      [next.id, prev.lockVersion, next.subject, next.intro, next.status, next.revision, next.generatedBy, json(next.draftNotes)],
    );
    if (!updated.length) throw new ConcurrentUpdateError();

    const keep = next.stories.map((s) => s.id);
    await tx.query(`delete from edition_stories where edition_id = $1 and not (id = any($2::text[]))`, [next.id, keep]);
    // Positions are unique only logically; park them first to avoid clashes on reorder.
    for (const s of next.stories) {
      await tx.query(
        `insert into edition_stories (id, edition_id, article_id, position, headline, publisher, url, published_at, topic, commentary,
           commentary_origin, rationale, rationale_origin, scores, warnings, corroborating, review_status, version, style_guide_version, cluster_id, history_note)
         values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21)
         on conflict (id) do update set position = excluded.position, headline = excluded.headline, topic = excluded.topic,
           commentary = excluded.commentary, commentary_origin = excluded.commentary_origin, rationale = excluded.rationale,
           rationale_origin = excluded.rationale_origin, scores = excluded.scores, warnings = excluded.warnings,
           corroborating = excluded.corroborating, review_status = excluded.review_status, version = excluded.version,
           style_guide_version = excluded.style_guide_version, cluster_id = excluded.cluster_id, history_note = excluded.history_note`,
        [
          s.id, next.id, s.articleId, s.position, s.headline, s.publisher, s.url, s.publishedAt, s.topic, s.commentary,
          s.commentaryOrigin, s.rationale, s.rationaleOrigin, json(s.scores), json(s.warnings), json(s.corroborating),
          s.reviewStatus, s.version, s.styleGuideVersion, s.clusterId, s.historyNote,
        ],
      );
    }

    const a = next.approval;
    if (a) {
      if (!prev.approval || prev.approval.id !== a.id) {
        // New approval: freeze the exact content it refers to.
        const snap = snapshotOf(next);
        await tx.query(
          `insert into edition_revisions (edition_id, revision, content_hash, snapshot) values ($1,$2,$3,$4::jsonb) on conflict do nothing`,
          [next.id, a.revision, a.contentHash, json(snap)],
        );
        await tx.query(
          `insert into approvals (id, edition_id, revision, content_hash, approved_by, approved_at, channel, send_at, send_now, recipient_count, sender)
           values ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::timestamptz,$9,$10,$11)`,
          [a.id, next.id, a.revision, a.contentHash, a.approvedBy, a.approvedAt, a.channel, a.sendAt, a.sendNow, a.recipientCount, a.sender],
        );
      } else if (a.revokedAt && !prev.approval.revokedAt) {
        await tx.query(`update approvals set revoked_at = $2::timestamptz, revoked_reason = $3 where id = $1`, [a.id, a.revokedAt, a.revokedReason]);
      }
    }
    return (await getEditionById(tx, next.id))!;
  });
}

export async function getSnapshot(db: Db, editionId: string, revision: number): Promise<{ snapshot: EditionSnapshot; contentHash: string } | null> {
  const [r] = await db.query<R>(`select * from edition_revisions where edition_id = $1 and revision = $2`, [editionId, revision]);
  return r ? { snapshot: r.snapshot as EditionSnapshot, contentHash: String(r.content_hash) } : null;
}

export async function setEditionStatus(db: Db, id: string, status: Edition["status"], extra: { publishedAt?: boolean } = {}) {
  await db.query(
    `update editions set status = $2, lock_version = lock_version + 1, updated_at = now()${extra.publishedAt ? ", published_at = coalesce(published_at, now())" : ""} where id = $1`,
    [id, status],
  );
}

// ---------- Editorial memory ----------

export async function recordPublishedRefs(db: Db, editionId: string, snap: EditionSnapshot) {
  for (const s of snap.stories) {
    await db.query(
      `insert into published_story_refs (id, workspace_id, edition_id, publish_date, article_id, normalized_url, headline, published_at)
       values ($1,$2,$3,$4::date,$5,$6,$7,$8::timestamptz) on conflict (edition_id, normalized_url) do nothing`,
      [newId("ref"), WORKSPACE_ID, editionId, snap.publishDate, s.articleId, normalizeUrl(s.url) ?? s.url, s.headline, s.publishedAt],
    );
  }
}

export async function coveredRefs(db: Db): Promise<CoveredRef[]> {
  const rows = await db.query<R>(
    `select r.*, a.description as article_description from published_story_refs r
       join editions e on e.id = r.edition_id
       left join articles a on a.id = r.article_id
     where r.workspace_id = $1 and e.published_at is not null
     order by r.publish_date desc limit 400`,
    [WORKSPACE_ID],
  );
  return rows.map((r) => ({
    editionId: String(r.edition_id),
    publishDate: ymd(r.publish_date),
    normalizedUrl: String(r.normalized_url),
    headline: String(r.headline),
    description: (r.article_description as string) ?? (r.description as string) ?? null,
    publishedAt: iso(r.published_at),
  }));
}

export async function importEdition(db: Db, input: { publishDate: string; subject: string; stories: Array<{ headline: string; url: string; publisher: string }> }) {
  return db.tx(async (tx) => {
    const [exists] = await tx.query<R>(`select id, origin, published_at from editions where workspace_id = $1 and publish_date = $2::date`, [WORKSPACE_ID, input.publishDate]);
    if (exists && exists.origin !== "import") throw new Error("An edition for that date already exists in the workflow.");
    const id = (exists?.id as string) ?? newId("ed");
    if (!exists) {
      await tx.query(
        `insert into editions (id, workspace_id, publish_date, subject, status, origin, published_at, revision) values ($1,$2,$3::date,$4,'SENT','import',$3::date,1)`,
        [id, WORKSPACE_ID, input.publishDate, input.subject],
      );
    }
    for (const s of input.stories) {
      await tx.query(
        `insert into published_story_refs (id, workspace_id, edition_id, publish_date, normalized_url, headline) values ($1,$2,$3,$4::date,$5,$6)
         on conflict (edition_id, normalized_url) do nothing`,
        [newId("ref"), WORKSPACE_ID, id, input.publishDate, normalizeUrl(s.url) ?? s.url, s.headline],
      );
    }
    return id;
  });
}

export async function archiveEditions(db: Db) {
  const eds = await db.query<R>(
    `select e.* from editions e where e.workspace_id = $1 and e.published_at is not null order by e.publish_date desc limit 30`,
    [WORKSPACE_ID],
  );
  const out = [];
  for (const e of eds) {
    const refs = await db.query<R>(`select r.headline, r.normalized_url, s.url, s.publisher from published_story_refs r
      left join edition_stories s on s.edition_id = r.edition_id and s.article_id = r.article_id where r.edition_id = $1`, [e.id]);
    const [d] = await db.query<R>(
      `select count(*) filter (where d.status = 'ACCEPTED')::int as accepted,
              count(*) filter (where d.status in ('FAILED_PERMANENT','FAILED_TEMPORARY'))::int as failed,
              count(*) filter (where d.status = 'UNKNOWN')::int as unknown, count(*)::int as total
       from deliveries d join campaigns c on c.id = d.campaign_id where c.edition_id = $1`,
      [e.id],
    );
    out.push({ e, refs, delivery: d && Number(d.total) > 0 ? d : null });
  }
  return out;
}

export { contentHash };
