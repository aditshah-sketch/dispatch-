import "server-only";
import { config } from "../config";
import { MIGRATIONS } from "./migrations";

// Minimal database interface: parameterised SQL in, plain rows out. Two
// drivers implement it — postgres.js for real deployments (Neon, Supabase,
// Vercel Postgres, any Postgres) and PGlite (embedded Postgres) for local
// development and tests. Both run the same SQL and the same constraints.

export type Row = Record<string, unknown>;

export interface Db {
  kind: "postgres" | "pglite";
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

type Global = typeof globalThis & { __dispatchDb?: Promise<Db>; __dispatchDbUrl?: string };
const g = globalThis as Global;

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

export async function getDb(): Promise<Db> {
  const c = config.database();
  if (!c.ok) throw new DatabaseUnavailableError("DATABASE_URL is not set — connected mode needs a database.");
  const url = c.value!.url;
  if (!g.__dispatchDb || g.__dispatchDbUrl !== url) {
    g.__dispatchDbUrl = url;
    g.__dispatchDb = open(url).catch((e) => {
      g.__dispatchDb = undefined;
      throw e;
    });
  }
  return g.__dispatchDb;
}

async function open(url: string): Promise<Db> {
  const db = url.startsWith("pglite:") ? await openPglite(url.slice("pglite:".length)) : await openPostgres(url);
  await migrate(db);
  return db;
}

async function openPglite(dir: string): Promise<Db> {
  if (config.isVercel()) {
    throw new DatabaseUnavailableError("The embedded pglite: database is for local development only. Use a hosted Postgres URL on Vercel.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  if (dir !== "memory" && dir !== "") {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  }
  const pg = dir === "memory" || dir === "" ? await PGlite.create() : await PGlite.create(dir);
  return wrapPglite(pg);
}

type PgliteLike = {
  query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: <T>(fn: (tx: { query: PgliteLike["query"] }) => Promise<T>) => Promise<T>;
};

// PGlite is single-connection; serialise access so concurrent requests in dev
// behave like separate transactions rather than interleaving.
export function wrapPglite(pg: unknown): Db {
  const p = pg as PgliteLike;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const inTx = (tx: { query: PgliteLike["query"] }): Db => ({
    kind: "pglite",
    query: async <T,>(t: string, params?: unknown[]) => (await tx.query(t, params ?? [])).rows as T[],
    tx: (fn) => fn(inTx(tx)),
  });
  return {
    kind: "pglite",
    query: <T,>(t: string, params?: unknown[]) => serial(async () => (await p.query(t, params ?? [])).rows as T[]),
    tx: (fn) => serial(() => p.transaction((tx) => fn(inTx(tx)))),
  };
}

async function openPostgres(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // postgres.js forwards unknown URL parameters to the server as settings;
  // drop provider hints (e.g. Supabase's `supa=…`) that Postgres would reject.
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (!["sslmode", "options", "application_name"].includes(k)) u.searchParams.delete(k);
  const sql = postgres(u.toString(), {
    max: config.isVercel() ? 3 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // compatible with transaction-mode poolers (Neon/Supabase pooler)
    onnotice: () => {},
  });
  // postgres.js: the root client and transaction handles share `unsafe`;
  // only the root has `begin`.
  type Handle = { unsafe: (t: string, p?: never[]) => Promise<unknown>; begin?: (fn: (tx: Handle) => Promise<unknown>) => Promise<unknown> };
  const wrap = (s: Handle, root: boolean): Db => ({
    kind: "postgres",
    query: async <T,>(t: string, params?: unknown[]) => (await s.unsafe(pgText(t), (params ?? []) as never[])) as unknown as T[],
    tx: async <T,>(fn: (db: Db) => Promise<T>): Promise<T> => {
      if (root && s.begin) return (await s.begin((tx) => fn(wrap(tx, false)))) as T;
      return fn(wrap(s, false)); // already inside a transaction
    },
  });
  return wrap(sql as unknown as Handle, true);
}

// Callers pass JSON already stringified and cast with `$n::jsonb`. postgres.js
// asks the server for parameter types and JSON-encodes jsonb parameters
// itself, which would double-encode them (stored as a JSON *string*). Casting
// through text keeps the parameter a plain string. PGlite doesn't need this.
export function pgText(text: string): string {
  return text.replace(/(\$\d+)::jsonb/g, "$1::text::jsonb");
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`create table if not exists schema_migrations (id int primary key, applied_at timestamptz not null default now())`);
  await db.tx(async (tx) => {
    if (tx.kind === "postgres") await tx.query(`select pg_advisory_xact_lock(724501)`);
    const done = new Set((await tx.query<{ id: number }>(`select id from schema_migrations`)).map((r) => Number(r.id)));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
      await tx.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
    }
  });
}

// Helpers for row mapping.
export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const json = (v: unknown) => JSON.stringify(v ?? null);
