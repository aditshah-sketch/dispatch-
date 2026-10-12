import "server-only";

// Configuration is read lazily at the capability boundary. Nothing here throws
// at import time, so the app builds and the preview runs with zero secrets;
// each feature reports exactly which variables it is missing.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export interface Capability<T> {
  ok: boolean;
  missing: string[];
  value: T | null;
}

function cap<T>(names: string[], build: () => T): Capability<T> {
  const missing = names.filter((n) => !env(n));
  return missing.length ? { ok: false, missing, value: null } : { ok: true, missing: [], value: build() };
}

export const config = {
  baseUrl(): string | null {
    const explicit = env("APP_BASE_URL");
    if (explicit) return explicit.replace(/\/+$/, "");
    const vercel = env("VERCEL_PROJECT_PRODUCTION_URL") ?? env("VERCEL_URL");
    return vercel ? `https://${vercel}` : null;
  },
  timezone(): string {
    return env("APP_TIMEZONE") ?? "Asia/Kolkata";
  },
  // DATABASE_URL, or POSTGRES_URL as injected by the Vercel Supabase/Neon integrations.
  database: () => {
    const url = env("DATABASE_URL") ?? env("POSTGRES_URL");
    return url ? { ok: true, missing: [], value: { url } } : { ok: false, missing: ["DATABASE_URL"], value: null };
  },
  auth: () =>
    cap(["AUTH_SECRET", "OWNER_PASSWORD"], () => ({
      secret: env("AUTH_SECRET")!,
      password: env("OWNER_PASSWORD")!,
      ownerName: env("OWNER_NAME") ?? "Shreya",
    })),
  tokenKey: () => cap(["TOKEN_ENCRYPTION_KEY"], () => ({ key: env("TOKEN_ENCRYPTION_KEY")! })),
  cron: () => cap(["CRON_SECRET"], () => ({ secret: env("CRON_SECRET")! })),
  gemini: () =>
    cap(["GEMINI_API_KEY"], () => ({
      apiKey: env("GEMINI_API_KEY")!,
      model: env("GEMINI_MODEL") ?? "gemini-3.8-flash",
      thinkingLevel: env("GEMINI_THINKING_LEVEL") ?? "low",
    })),
  scrapingBee: () =>
    cap(["SCRAPINGBEE_API_KEY"], () => ({
      apiKey: env("SCRAPINGBEE_API_KEY")!,
      maxPagesPerRun: Number(env("SCRAPINGBEE_MAX_PAGES_PER_RUN") ?? 25),
      renderJs: env("SCRAPINGBEE_RENDER_JS") === "true",
    })),
  newsApi: () =>
    cap(["GNEWS_API_KEY"], () => ({
      apiKey: env("GNEWS_API_KEY")!,
      plan: (env("GNEWS_PLAN") ?? "free") as "free" | "paid",
    })),
  telegram: () =>
    cap(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"], () => ({
      token: env("TELEGRAM_BOT_TOKEN")!,
      webhookSecret: env("TELEGRAM_WEBHOOK_SECRET")!,
      ownerChatId: env("TELEGRAM_OWNER_CHAT_ID") ?? null,
    })),
  resend: () =>
    cap(["RESEND_API_KEY", "RESEND_FROM"], () => ({
      apiKey: env("RESEND_API_KEY")!,
      from: env("RESEND_FROM")!, // "The Dispatch <news@your-verified-domain.com>"
      webhookSecret: env("RESEND_WEBHOOK_SECRET") ?? null,
    })),
  // Which provider sends the newsletter. Defaults to Resend when configured.
  emailProvider(): "resend" | "gmail" {
    const explicit = env("EMAIL_PROVIDER");
    if (explicit === "gmail" || explicit === "resend") return explicit;
    return config.resend().ok ? "resend" : "gmail";
  },
  google: () =>
    cap(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"], () => ({
      clientId: env("GOOGLE_CLIENT_ID")!,
      clientSecret: env("GOOGLE_CLIENT_SECRET")!,
      redirectUri: env("GOOGLE_REDIRECT_URI") ?? `${config.baseUrl() ?? "http://localhost:3000"}/api/google/callback`,
    })),
  isVercel(): boolean {
    return !!env("VERCEL");
  },
};

export const WORKSPACE_ID = "default";
