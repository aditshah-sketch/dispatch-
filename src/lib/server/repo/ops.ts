import "server-only";
import { newId } from "../../domain/edition";
import type { SubscriberStatus } from "../../domain/types";
import type { ActivityView, JobView, NotificationView, SubscriberRow } from "../../views";
import { WORKSPACE_ID } from "../config";
import { iso, json, type Db } from "../db/client";

type R = Record<string, unknown>;

// ---------- Audit & notifications ----------

export async function audit(db: Db, e: { actor: string; action: string; message: string; entityType?: string; entityId?: string; details?: Record<string, unknown> }) {
  await db.query(
    `insert into audit_events (id, workspace_id, actor, action, entity_type, entity_id, message, details) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [newId("aud"), WORKSPACE_ID, e.actor, e.action, e.entityType ?? null, e.entityId ?? null, e.message.slice(0, 1000), json(e.details ?? {})],
  );
}

export async function recentActivity(db: Db, limit = 40): Promise<ActivityView[]> {
  const rows = await db.query<R>(`select * from audit_events where workspace_id = $1 order by at desc limit $2`, [WORKSPACE_ID, limit]);
  return rows.map((r) => ({ id: String(r.id), at: iso(r.at)!, actor: String(r.actor), action: String(r.action), message: String(r.message) }));
}

export async function notify(db: Db, n: { editionId: string | null; kind: NotificationView["kind"]; channel: NotificationView["channel"]; status: NotificationView["status"]; revision?: number | null; detail: string }) {
  await db.query(
    `insert into notifications (id, workspace_id, edition_id, kind, channel, status, revision, detail) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [newId("ntf"), WORKSPACE_ID, n.editionId, n.kind, n.channel, n.status, n.revision ?? null, n.detail.slice(0, 1000)],
  );
}

export async function notificationsFor(db: Db, editionId: string): Promise<NotificationView[]> {
  const rows = await db.query<R>(`select * from notifications where workspace_id = $1 and edition_id = $2 order by created_at desc limit 20`, [WORKSPACE_ID, editionId]);
  return rows.map((r) => ({
    id: String(r.id), kind: r.kind as NotificationView["kind"], channel: r.channel as NotificationView["channel"],
    status: r.status as NotificationView["status"], detail: String(r.detail), at: iso(r.created_at)!,
  }));
}

// ---------- Integration health ----------

export async function markHealth(db: Db, integration: string, ok: boolean, error?: string | null) {
  await db.query(
    ok
      ? `insert into integration_health (workspace_id, integration, last_success_at) values ($1,$2,now())
         on conflict (workspace_id, integration) do update set last_success_at = now()`
      : `insert into integration_health (workspace_id, integration, last_error_at, last_error) values ($1,$2,now(),$3)
         on conflict (workspace_id, integration) do update set last_error_at = now(), last_error = $3`,
    ok ? [WORKSPACE_ID, integration] : [WORKSPACE_ID, integration, (error ?? "").slice(0, 300)],
  );
}

export async function healthMap(db: Db): Promise<Map<string, { lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null }>> {
  const rows = await db.query<R>(`select * from integration_health where workspace_id = $1`, [WORKSPACE_ID]);
  return new Map(rows.map((r) => [String(r.integration), { lastSuccessAt: iso(r.last_success_at), lastErrorAt: iso(r.last_error_at), lastError: (r.last_error as string) ?? null }]));
}

// ---------- Rate limiting (durable, works across serverless instances) ----------

export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
  const [r] = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, $2::timestamptz, 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1 returning count`,
    [key, windowStart],
  );
  if (Math.random() < 0.02) await db.query(`delete from rate_limits where window_start < now() - interval '2 days'`);
  return Number(r.count) <= limit;
}

// ---------- Subscribers ----------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function subscriberCounts(db: Db): Promise<Record<SubscriberStatus, number> & { total: number }> {
  const rows = await db.query<{ status: SubscriberStatus; n: number }>(`select status, count(*)::int as n from subscribers where workspace_id = $1 group by status`, [WORKSPACE_ID]);
  const out = { ACTIVE: 0, UNSUBSCRIBED: 0, BOUNCED: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = Number(r.n);
    out.total += Number(r.n);
  }
  return out;
}

export async function listSubscribers(db: Db, limit = 300): Promise<SubscriberRow[]> {
  const rows = await db.query<R>(`select * from subscribers where workspace_id = $1 order by created_at desc limit $2`, [WORKSPACE_ID, limit]);
  return rows.map((r) => ({ id: String(r.id), email: String(r.email), name: (r.name as string) ?? null, status: r.status as SubscriberStatus, reason: (r.status_reason as string) ?? null, updatedAt: iso(r.updated_at)! }));
}

// Re-importing an address never changes its status — an unsubscribe sticks.
export async function addSubscriber(db: Db, email: string, name: string | null, source = "manual"): Promise<boolean> {
  const rows = await db.query(
    `insert into subscribers (id, workspace_id, email, email_normalized, name, status, source) values ($1,$2,$3,$4,$5,'ACTIVE',$6)
     on conflict (workspace_id, email_normalized) do nothing returning id`,
    [newId("sub"), WORKSPACE_ID, email.trim(), normalizeEmail(email), name, source],
  );
  return rows.length > 0;
}

export async function setSubscriberStatus(db: Db, id: string, status: SubscriberStatus, reason: string) {
  await db.query(`update subscribers set status = $3, status_reason = $4, updated_at = now() where id = $1 and workspace_id = $2`, [id, WORKSPACE_ID, status, reason]);
}

export async function getSubscriber(db: Db, id: string) {
  const [r] = await db.query<R>(`select * from subscribers where id = $1 and workspace_id = $2`, [id, WORKSPACE_ID]);
  return r ? { id: String(r.id), email: String(r.email), status: r.status as SubscriberStatus, tempFailures: Number(r.temp_failures) } : null;
}

// ---------- Jobs (durable outbox) ----------

export type JobKind = "COLLECT" | "GENERATE_DRAFT" | "DELIVER_DRAFT" | "REMINDER" | "SEND_CAMPAIGN" | "PROCESS_FEEDBACK";

export interface Job {
  id: string;
  kind: JobKind;
  dedupeKey: string;
  status: JobView["status"];
  runAt: string;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  stage: string | null;
  lastError: string | null;
  updatedAt: string;
}

function mapJob(r: R): Job {
  return {
    id: String(r.id), kind: r.kind as JobKind, dedupeKey: String(r.dedupe_key), status: r.status as Job["status"],
    runAt: iso(r.run_at)!, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    payload: (r.payload as Record<string, unknown>) ?? {}, stage: (r.stage as string) ?? null,
    lastError: (r.last_error as string) ?? null, updatedAt: iso(r.updated_at)!,
  };
}

// Idempotent enqueue: the dedupe key makes duplicate cron invocations harmless.
export async function enqueue(db: Db, j: { kind: JobKind; dedupeKey: string; runAt?: string; payload?: Record<string, unknown>; maxAttempts?: number }): Promise<{ job: Job; created: boolean }> {
  const inserted = await db.query<R>(
    `insert into jobs (id, workspace_id, kind, dedupe_key, status, run_at, payload, max_attempts) values ($1,$2,$3,$4,'QUEUED',$5::timestamptz,$6::jsonb,$7)
     on conflict (workspace_id, dedupe_key) do nothing returning *`,
    [newId("job"), WORKSPACE_ID, j.kind, j.dedupeKey, j.runAt ?? new Date().toISOString(), json(j.payload ?? {}), j.maxAttempts ?? 3],
  );
  if (inserted.length) return { job: mapJob(inserted[0]), created: true };
  const [existing] = await db.query<R>(`select * from jobs where workspace_id = $1 and dedupe_key = $2`, [WORKSPACE_ID, j.dedupeKey]);
  return { job: mapJob(existing), created: false };
}

// Re-arms a finished job under the same key (used for explicit manual reruns).
export async function rearm(db: Db, dedupeKey: string, runAt?: string) {
  await db.query(
    `update jobs set status = 'QUEUED', attempts = 0, run_at = coalesce($3::timestamptz, now()), last_error = null, stage = null, updated_at = now()
     where workspace_id = $1 and dedupe_key = $2 and status in ('SUCCEEDED','FAILED','CANCELLED')`,
    [WORKSPACE_ID, dedupeKey, runAt ?? null],
  );
}

// Claims a job with a lease. Only one worker can hold it; an expired lease
// (crashed function) makes it claimable again.
export async function claim(db: Db, opts: { id?: string; leaseSeconds?: number } = {}): Promise<Job | null> {
  const lease = opts.leaseSeconds ?? 280;
  const rows = await db.query<R>(
    `update jobs set status = 'RUNNING', attempts = attempts + 1, lease_until = now() + ($2::int * interval '1 second'), updated_at = now()
     where id = (
       select id from jobs where workspace_id = $1
         and ${opts.id ? "id = $3 and" : ""} run_at <= now()
         and (status = 'QUEUED' or (status = 'RUNNING' and lease_until < now()))
       order by run_at limit 1 for update skip locked)
     returning *`,
    opts.id ? [WORKSPACE_ID, lease, opts.id] : [WORKSPACE_ID, lease],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function setJobStage(db: Db, id: string, stage: string) {
  await db.query(`update jobs set stage = $2, updated_at = now() where id = $1`, [id, stage]);
}

export async function finishJob(db: Db, id: string, result: Record<string, unknown> = {}) {
  await db.query(`update jobs set status = 'SUCCEEDED', result = $2::jsonb, lease_until = null, stage = null, updated_at = now() where id = $1`, [id, json(result)]);
}

// Finite retries with exponential backoff; after the budget, FAILED.
export async function failJob(db: Db, job: Job, error: string, opts: { retryable: boolean; retryInSeconds?: number }) {
  const exhausted = !opts.retryable || job.attempts >= job.maxAttempts;
  const delay = opts.retryInSeconds ?? Math.min(3600, 60 * 2 ** (job.attempts - 1));
  await db.query(
    `update jobs set status = $2, last_error = $3, lease_until = null, run_at = case when $2 = 'QUEUED' then now() + ($4::int * interval '1 second') else run_at end, updated_at = now() where id = $1`,
    [job.id, exhausted ? "FAILED" : "QUEUED", error.slice(0, 500), delay],
  );
}

// A job that should be re-run later without consuming a retry (e.g. a send
// campaign paused at a checkpoint or waiting for quota).
export async function deferJob(db: Db, id: string, runAt: string, stage: string) {
  await db.query(`update jobs set status = 'QUEUED', run_at = $2::timestamptz, attempts = greatest(attempts - 1, 0), lease_until = null, stage = $3, updated_at = now() where id = $1`, [id, runAt, stage]);
}

export async function cancelJobs(db: Db, dedupePrefix: string) {
  await db.query(`update jobs set status = 'CANCELLED', updated_at = now() where workspace_id = $1 and dedupe_key like $2 and status = 'QUEUED'`, [WORKSPACE_ID, `${dedupePrefix}%`]);
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const [r] = await db.query<R>(`select * from jobs where id = $1 and workspace_id = $2`, [id, WORKSPACE_ID]);
  return r ? mapJob(r) : null;
}

export async function latestJob(db: Db, kinds: JobKind[], prefix: string): Promise<Job | null> {
  const [r] = await db.query<R>(
    `select * from jobs where workspace_id = $1 and kind = any($2::text[]) and dedupe_key like $3 order by updated_at desc limit 1`,
    [WORKSPACE_ID, kinds, `${prefix}%`],
  );
  return r ? mapJob(r) : null;
}

export function jobView(j: Job | null): JobView | null {
  if (!j) return null;
  return { id: j.id, kind: j.kind, status: j.status, stage: j.stage, error: j.lastError, updatedAt: j.updatedAt };
}
