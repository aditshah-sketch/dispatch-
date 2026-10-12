import "server-only";
import { DEFAULT_BRANDING } from "../../domain/email-render";
import { DEFAULT_SCHEDULE, type ScheduleConfig } from "../../domain/schedule";
import { STARTER_STYLE_GUIDE } from "../../domain/style-guide";
import { newId } from "../../domain/edition";
import { config, WORKSPACE_ID } from "../config";
import { iso, json, type Db } from "../db/client";

export interface SendingSettings {
  fromName: string;
  replyTo: string;
  dailyLimit: number;
  accountType: "gmail" | "workspace" | "resend" | "custom";
}

export interface WorkspaceSettings {
  schedule: ScheduleConfig;
  sending: SendingSettings;
  newsletter: { name: string; footer: string };
  telegramChatId: string | null;
  telegramLinkCode: string | null;
  telegramLinkExpiresAt: string | null;
  gmailFeedbackCheckedAt: string | null;
}

// Default sources for the Indian startup ecosystem. Each URL was fetched and
// returned a parseable feed on 2026-10-12; that note is shown in the UI and
// replaced by live health once collection runs.
export const DEFAULT_SOURCES: Array<{ kind: "rss" | "news_query"; name: string; locator: string; note: string; enabled?: boolean }> = [
  { kind: "rss", name: "Inc42", locator: "https://inc42.com/feed/", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "Entrackr", locator: "https://entrackr.com/rss", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "YourStory", locator: "https://yourstory.com/feed", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "ET Tech · Startups", locator: "https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570540.cms", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "ET Tech", locator: "https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "TechCrunch · India", locator: "https://techcrunch.com/tag/india/feed/", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "Mint · Companies", locator: "https://www.livemint.com/rss/companies", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "Mint · Technology", locator: "https://www.livemint.com/rss/technology", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "MediaNama", locator: "https://www.medianama.com/feed/", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "BusinessLine · Info-tech", locator: "https://www.thehindubusinessline.com/info-tech/feeder/default.rss", note: "Verified reachable 2026-10-12" },
  { kind: "rss", name: "Rest of World", locator: "https://restofworld.org/feed/latest/", note: "Verified reachable 2026-10-12 · global, filtered by relevance" },
  { kind: "rss", name: "The Ken", locator: "https://the-ken.com/feed/", note: "Verified reachable 2026-10-12 · paywalled, summaries only" },
  { kind: "news_query", name: "Funding rounds", locator: "Indian startup raises funding", note: "GNews search" },
  { kind: "news_query", name: "Regulation", locator: "startup India RBI OR SEBI OR MeitY", note: "GNews search" },
  { kind: "news_query", name: "Layoffs & governance", locator: "Indian startup layoffs OR founder resigns", note: "GNews search" },
  { kind: "news_query", name: "IPOs & acquisitions", locator: "Indian startup IPO OR acquisition", note: "GNews search" },
];

export async function ensureWorkspace(db: Db): Promise<void> {
  const rows = await db.query(`select 1 from workspace_settings where workspace_id = $1`, [WORKSPACE_ID]);
  if (rows.length) return;
  await db.tx(async (tx) => {
    const schedule = { ...DEFAULT_SCHEDULE, timezone: config.timezone() };
    await tx.query(
      `insert into workspace_settings (workspace_id, schedule, sending, newsletter) values ($1, $2::jsonb, $3::jsonb, $4::jsonb) on conflict do nothing`,
      [
        WORKSPACE_ID,
        json(schedule),
        json({ fromName: DEFAULT_BRANDING.fromName, replyTo: "", dailyLimit: 500, accountType: "gmail" } satisfies SendingSettings),
        json({ name: DEFAULT_BRANDING.newsletterName, footer: DEFAULT_BRANDING.footer }),
      ],
    );
    await tx.query(
      `insert into style_guides (workspace_id, version, content, is_starter) values ($1, 1, $2, true) on conflict do nothing`,
      [WORKSPACE_ID, STARTER_STYLE_GUIDE],
    );
    for (const s of DEFAULT_SOURCES) {
      await tx.query(
        `insert into sources (id, workspace_id, kind, name, locator, enabled, verified_note) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
        [newId("src"), WORKSPACE_ID, s.kind, s.name, s.locator, s.enabled ?? true, s.note],
      );
    }
  });
}

export async function getSettings(db: Db): Promise<WorkspaceSettings> {
  await ensureWorkspace(db);
  const [r] = await db.query<Record<string, unknown>>(`select * from workspace_settings where workspace_id = $1`, [WORKSPACE_ID]);
  return {
    schedule: { ...DEFAULT_SCHEDULE, ...(r.schedule as ScheduleConfig) },
    sending: r.sending as SendingSettings,
    newsletter: r.newsletter as WorkspaceSettings["newsletter"],
    telegramChatId: (r.telegram_chat_id as string) ?? null,
    telegramLinkCode: (r.telegram_link_code as string) ?? null,
    telegramLinkExpiresAt: iso(r.telegram_link_expires_at),
    gmailFeedbackCheckedAt: iso(r.gmail_history_checked_at),
  };
}

export async function updateSettings(db: Db, patch: Partial<{ schedule: ScheduleConfig; sending: SendingSettings; newsletter: WorkspaceSettings["newsletter"] }>) {
  const sets: string[] = [];
  const params: unknown[] = [WORKSPACE_ID];
  for (const [k, v] of Object.entries(patch)) {
    params.push(json(v));
    sets.push(`${k} = $${params.length}::jsonb`);
  }
  if (!sets.length) return;
  await db.query(`update workspace_settings set ${sets.join(", ")}, updated_at = now() where workspace_id = $1`, params);
}

export async function getStyleGuide(db: Db) {
  await ensureWorkspace(db);
  const [r] = await db.query<Record<string, unknown>>(
    `select * from style_guides where workspace_id = $1 order by version desc limit 1`,
    [WORKSPACE_ID],
  );
  return {
    version: Number(r.version),
    content: String(r.content),
    examples: String(r.examples ?? ""),
    isStarter: !!r.is_starter,
    updatedAt: iso(r.created_at)!,
  };
}

export async function saveStyleGuide(db: Db, content: string, examples: string): Promise<number> {
  return db.tx(async (tx) => {
    const [r] = await tx.query<{ v: number }>(`select coalesce(max(version), 0)::int as v from style_guides where workspace_id = $1`, [WORKSPACE_ID]);
    const version = Number(r.v) + 1;
    await tx.query(`insert into style_guides (workspace_id, version, content, examples, is_starter) values ($1,$2,$3,$4,false)`, [WORKSPACE_ID, version, content, examples]);
    return version;
  });
}
