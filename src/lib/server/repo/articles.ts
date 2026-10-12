import "server-only";
import { newId } from "../../domain/edition";
import { isTopicId } from "../../domain/topics";
import type { Article } from "../../domain/types";
import type { RunRow, SourceRow } from "../../views";
import { WORKSPACE_ID } from "../config";
import { iso, json, type Db } from "../db/client";

type R = Record<string, unknown>;

export function mapArticle(r: R): Article {
  return {
    id: String(r.id),
    sourceId: (r.source_id as string) ?? null,
    publisher: String(r.publisher),
    url: String(r.url),
    normalizedUrl: String(r.normalized_url),
    headline: String(r.headline),
    author: (r.author as string) ?? null,
    publishedAt: iso(r.published_at),
    fetchedAt: iso(r.fetched_at)!,
    description: (r.description as string) ?? null,
    extractedText: (r.extracted_text as string) ?? null,
    fingerprint: (r.fingerprint as string) ?? null,
    extractionStatus: r.extraction_status as Article["extractionStatus"],
    provenance: r.provenance as Article["provenance"],
    topic: isTopicId(r.topic) ? r.topic : null,
    topicOrigin: (r.topic_origin as Article["topicOrigin"]) ?? null,
    clusterId: (r.cluster_id as string) ?? null,
    evidenceNotes: (r.evidence_notes as string[]) ?? [],
  };
}

export interface NewArticle {
  sourceId: string | null;
  publisher: string;
  url: string;
  normalizedUrl: string;
  headline: string;
  author: string | null;
  publishedAt: string | null;
  description: string | null;
  extractedText: string | null;
  fingerprint: string;
  extractionStatus: Article["extractionStatus"];
  provenance: Article["provenance"];
  evidenceNotes: string[];
}

// Idempotent insert keyed on (workspace, normalized_url). Returns whether the
// row is new. Re-collecting the same article never creates a duplicate.
export async function upsertArticle(db: Db, a: NewArticle): Promise<{ id: string; inserted: boolean }> {
  const rows = await db.query<{ id: string; inserted: boolean }>(
    `insert into articles (id, workspace_id, source_id, publisher, url, normalized_url, headline, author, published_at, description,
       extracted_text, fingerprint, extraction_status, provenance, evidence_notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15::jsonb)
     on conflict (workspace_id, normalized_url) do update
       set description = coalesce(articles.description, excluded.description),
           published_at = coalesce(articles.published_at, excluded.published_at)
     returning id, (xmax = 0) as inserted`,
    [
      newId("art"), WORKSPACE_ID, a.sourceId, a.publisher, a.url, a.normalizedUrl, a.headline, a.author, a.publishedAt,
      a.description, a.extractedText, a.fingerprint, a.extractionStatus, a.provenance, json(a.evidenceNotes),
    ],
  );
  return { id: rows[0].id, inserted: !!rows[0].inserted };
}

export async function articlesSince(db: Db, sinceIso: string, limit = 800): Promise<Article[]> {
  // Articles with unknown dates are included only if fetched in the window.
  const rows = await db.query<R>(
    `select * from articles where workspace_id = $1 and (published_at >= $2::timestamptz - interval '3 days' or (published_at is null and fetched_at >= $2::timestamptz))
     order by coalesce(published_at, fetched_at) desc limit $3`,
    [WORKSPACE_ID, sinceIso, limit],
  );
  return rows.map(mapArticle);
}

export async function getArticles(db: Db, ids: string[]): Promise<Article[]> {
  if (!ids.length) return [];
  const rows = await db.query<R>(`select * from articles where workspace_id = $1 and id = any($2::text[])`, [WORKSPACE_ID, ids]);
  return rows.map(mapArticle);
}

export async function articlesNeedingContent(db: Db, sinceIso: string, limit: number): Promise<Article[]> {
  const rows = await db.query<R>(
    `select * from articles where workspace_id = $1 and extraction_attempted_at is null and extraction_status = 'FEED_ONLY'
       and coalesce(length(extracted_text), 0) < 800 and published_at >= $2::timestamptz
     order by published_at desc limit $3`,
    [WORKSPACE_ID, sinceIso, limit],
  );
  return rows.map(mapArticle);
}

export async function saveExtraction(db: Db, id: string, e: { status: Article["extractionStatus"]; text: string | null; note: string | null }) {
  await db.query(
    `update articles set extraction_status = $2, extracted_text = coalesce($3, extracted_text), extraction_attempted_at = now(),
       evidence_notes = case when $4::text is null then evidence_notes else evidence_notes || jsonb_build_array($4::text) end
     where id = $1`,
    [id, e.status, e.text, e.note],
  );
}

export async function saveTopics(db: Db, topics: Array<{ id: string; topic: string; origin: "ai" | "rules" | "editor" }>) {
  for (const t of topics) await db.query(`update articles set topic = $2, topic_origin = $3 where id = $1`, [t.id, t.topic, t.origin]);
}

export async function saveClusters(db: Db, clusterOf: Map<string, string>) {
  for (const [id, c] of clusterOf) await db.query(`update articles set cluster_id = $2 where id = $1 and cluster_id is distinct from $2`, [id, c]);
}

// ---------- Sources ----------

export interface SourceRecord {
  id: string;
  kind: "rss" | "news_query";
  name: string;
  locator: string;
  enabled: boolean;
}

export async function listSources(db: Db): Promise<SourceRow[]> {
  const rows = await db.query<R>(`select * from sources where workspace_id = $1 order by kind, name`, [WORKSPACE_ID]);
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as SourceRow["kind"],
    name: String(r.name),
    locator: String(r.locator),
    enabled: !!r.enabled,
    verifiedNote: (r.verified_note as string) ?? null,
    lastRunAt: iso(r.last_run_at),
    lastStatus: (r.last_status as SourceRow["lastStatus"]) ?? null,
    lastError: (r.last_error as string) ?? null,
    lastItemCount: r.last_item_count == null ? null : Number(r.last_item_count),
  }));
}

export async function recordSourceResult(db: Db, id: string, r: { status: "OK" | "FAILED" | "EMPTY" | "SKIPPED"; error: string | null; count: number | null }) {
  await db.query(`update sources set last_run_at = now(), last_status = $2, last_error = $3, last_item_count = $4 where id = $1`, [id, r.status, r.error?.slice(0, 300) ?? null, r.count]);
}

export async function setSourceEnabled(db: Db, id: string, enabled: boolean) {
  await db.query(`update sources set enabled = $3 where id = $1 and workspace_id = $2`, [id, WORKSPACE_ID, enabled]);
}

export async function addSource(db: Db, s: { kind: "rss" | "news_query"; name: string; locator: string }) {
  await db.query(
    `insert into sources (id, workspace_id, kind, name, locator, enabled, verified_note) values ($1,$2,$3,$4,$5,true,'Added by you') on conflict (workspace_id, kind, locator) do update set enabled = true`,
    [newId("src"), WORKSPACE_ID, s.kind, s.name, s.locator],
  );
}

// ---------- Runs ----------

export async function startRun(db: Db, publishDate: string, trigger: string): Promise<string> {
  const id = newId("run");
  await db.query(`insert into ingestion_runs (id, workspace_id, edition_publish_date, trigger, status) values ($1,$2,$3::date,$4,'RUNNING')`, [id, WORKSPACE_ID, publishDate, trigger]);
  return id;
}

export async function finishRun(db: Db, id: string, status: "SUCCEEDED" | "PARTIAL" | "FAILED", stats: Record<string, unknown>, sourceResults: unknown[]) {
  await db.query(`update ingestion_runs set status = $2, finished_at = now(), stats = $3::jsonb, source_results = $4::jsonb where id = $1`, [id, status, json(stats), json(sourceResults)]);
}

export async function recentRuns(db: Db, limit = 8): Promise<RunRow[]> {
  const rows = await db.query<R>(`select * from ingestion_runs where workspace_id = $1 order by started_at desc limit $2`, [WORKSPACE_ID, limit]);
  return rows.map((r) => {
    const s = (r.stats ?? {}) as Record<string, number>;
    return {
      id: String(r.id),
      trigger: String(r.trigger),
      status: String(r.status),
      startedAt: iso(r.started_at)!,
      finishedAt: iso(r.finished_at),
      summary: r.status === "RUNNING" ? "In progress…" : `${s.fetched ?? 0} items fetched · ${s.inserted ?? 0} new · ${s.existing ?? 0} already stored · ${s.sourcesFailed ?? 0} source failures · ${s.pagesFetched ?? 0} pages retrieved`,
    };
  });
}
