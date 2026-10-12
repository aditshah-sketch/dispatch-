import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { migrate, wrapPglite, type Db } from "@/lib/server/db/client";

// Test environment: no real credentials, deterministic secrets.
export function setTestEnv() {
  Object.assign(process.env, {
    APP_BASE_URL: "https://dispatch.test",
    AUTH_SECRET: "test-auth-secret-0123456789",
    OWNER_PASSWORD: "test-owner-password",
    TOKEN_ENCRYPTION_KEY: "test-token-key-0123456789",
    CRON_SECRET: "test-cron-secret",
    GOOGLE_CLIENT_ID: "client-id.test",
    GOOGLE_CLIENT_SECRET: "client-secret",
    TELEGRAM_BOT_TOKEN: "123:test",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    TELEGRAM_OWNER_CHAT_ID: "4242",
    GEMINI_API_KEY: "gemini-test",
    GEMINI_MODEL: "gemini-3.8-flash",
    DISPATCH_SEND_INTERVAL_MS: "0",
  });
  delete process.env.GNEWS_API_KEY;
  delete process.env.SCRAPINGBEE_API_KEY;
}

export async function makeDb(): Promise<Db> {
  const db = wrapPglite(await PGlite.create());
  await migrate(db);
  return db;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

// Routes outgoing fetch calls to fakes and records them. Any unexpected call
// fails the test — no real network traffic, no real sends.
export function mockFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; body: string | null }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: typeof init.body === "string" ? init.body : null });
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, count: (re: RegExp) => calls.filter((c) => re.test(c.url)).length };
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function rss(items: Array<{ title: string; link: string; description?: string; pubDate?: string }>) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description ?? ""}</description><pubDate>${i.pubDate ?? new Date().toUTCString()}</pubDate></item>`)
    .join("")}</channel></rss>`;
}

export function geminiResponse(data: unknown) {
  return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
}
