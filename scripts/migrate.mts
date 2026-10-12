// Applies database migrations explicitly (they also run automatically on the
// first connection). Usage: DATABASE_URL=postgres://… npm run db:migrate
import { MIGRATIONS } from "../src/lib/server/db/migrations.ts";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

type Q = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
let query: Q;
let close: () => Promise<void>;
if (url.startsWith("pglite:")) {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(url.slice(7));
  query = async (t, p) => (await db.query(t, p ?? [])).rows as Array<Record<string, unknown>>;
  close = () => db.close();
} else {
  const { default: postgres } = await import("postgres");
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (!["sslmode", "options", "application_name"].includes(k)) u.searchParams.delete(k);
  const sql = postgres(u.toString(), { max: 1, prepare: false });
  query = async (t, p) => (await sql.unsafe(t, (p ?? []) as never[])) as unknown as Array<Record<string, unknown>>;
  close = () => sql.end();
}

await query(`create table if not exists schema_migrations (id int primary key, applied_at timestamptz not null default now())`);
const done = new Set((await query(`select id from schema_migrations`)).map((r) => Number(r.id)));
for (const m of MIGRATIONS) {
  if (done.has(m.id)) {
    console.log(`✓ ${m.id} ${m.name} (already applied)`);
    continue;
  }
  await query("begin");
  try {
    for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await query(stmt);
    await query(`insert into schema_migrations (id) values ($1)`, [m.id]);
    await query("commit");
    console.log(`+ ${m.id} ${m.name}`);
  } catch (e) {
    await query("rollback");
    console.error(`✗ ${m.id} ${m.name}: ${(e as Error).message}`);
    process.exit(1);
  }
}
await close();
