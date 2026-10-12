import "server-only";
import { apiFetch } from "../net/safe-fetch";

// Google OAuth 2.0 (web server flow), Gmail API and Calendar API adapters.
// Scopes are requested per feature with incremental authorization, so the
// mailbox-reading scope is only requested when delivery feedback is enabled.

export const SCOPES = {
  identity: ["openid", "email"],
  send: ["https://www.googleapis.com/auth/gmail.send"],
  feedback: ["https://www.googleapis.com/auth/gmail.readonly"], // restricted scope
  calendar: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"],
} as const;

export type GoogleFeature = "send" | "feedback" | "calendar";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly kind: "AUTH" | "REVOKED" | "QUOTA" | "PERMANENT" | "TEMPORARY" | "UNKNOWN" | "CONFLICT" | "NOT_FOUND" | "SCOPE",
    readonly status = 0,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export function buildAuthUrl(o: { clientId: string; redirectUri: string; feature: GoogleFeature; state: string; loginHint?: string | null }): string {
  const scopes = [...SCOPES.identity, ...SCOPES[o.feature]];
  const p = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent", // ensures a refresh token is issued on reconnect
    state: o.state,
  });
  if (o.loginHint) p.set("login_hint", o.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  idToken?: string | null;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await apiFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      timeoutMs: 15_000,
    });
  } catch (e) {
    throw new GoogleApiError(`Couldn't reach Google: ${(e as Error).message}`, "TEMPORARY");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    if (data.error === "invalid_grant") throw new GoogleApiError("Google access was revoked or expired. Reconnect your Google account.", "REVOKED", res.status);
    throw new GoogleApiError(`Google token error: ${data.error_description ?? data.error ?? res.status}`, res.status >= 500 ? "TEMPORARY" : "AUTH", res.status);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
    idToken: data.id_token ?? null,
  };
}

export function exchangeCode(o: { clientId: string; clientSecret: string; redirectUri: string; code: string }) {
  return tokenRequest({ code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: "authorization_code" });
}

export function refreshAccessToken(o: { clientId: string; clientSecret: string; refreshToken: string }) {
  return tokenRequest({ refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret, grant_type: "refresh_token" });
}

// The email claim from the ID token we just received directly from Google's
// token endpoint over TLS (so signature verification isn't required here).
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function googleCall(url: string, accessToken: string, init: RequestInit & { timeoutMs?: number } = {}) {
  try {
    return await apiFetch(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  } catch (e) {
    // The request may or may not have reached Google.
    throw new GoogleApiError(`No response from Google (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`, "UNKNOWN");
  }
}

async function classify(res: Response, context: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string } };
  const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  const msg = body.error?.message ?? res.statusText;
  if (res.status === 401) throw new GoogleApiError(`${context}: Google rejected the access token.`, "AUTH", 401);
  if (res.status === 403 && /insufficient|scope|PERMISSION_DENIED/i.test(`${reason} ${msg}`)) throw new GoogleApiError(`${context}: the connected account didn't grant the needed permission.`, "SCOPE", 403);
  if (res.status === 429 || /rateLimit|dailyLimit|quota|userRateLimit/i.test(reason) || /limit exceeded/i.test(msg)) throw new GoogleApiError(`${context}: sending limit or rate limit reached (${msg}).`, "QUOTA", res.status);
  if (res.status === 409) throw new GoogleApiError(`${context}: already exists.`, "CONFLICT", 409);
  if (res.status === 404) throw new GoogleApiError(`${context}: not found.`, "NOT_FOUND", 404);
  if (res.status >= 500) throw new GoogleApiError(`${context}: Google is temporarily unavailable (${res.status}).`, "TEMPORARY", res.status);
  throw new GoogleApiError(`${context}: ${msg}`, "PERMANENT", res.status);
}

// ---------- Gmail ----------

function encodeHeader(v: string): string {
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export interface MimeMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  deliveryRef: string;
}

// One recipient per message: the subscriber list is never exposed in headers.
export function buildMime(m: MimeMessage): string {
  const boundary = `dispatch_${m.deliveryRef.replace(/[^a-z0-9]/gi, "")}`;
  const safe = (s: string) => s.replace(/[\r\n]+/g, " ");
  const headers = [
    `From: ${encodeHeader(safe(m.fromName))} <${safe(m.fromEmail)}>`,
    `To: <${safe(m.to)}>`,
    m.replyTo ? `Reply-To: <${safe(m.replyTo)}>` : null,
    `Subject: ${encodeHeader(safe(m.subject))}`,
    `MIME-Version: 1.0`,
    `List-Unsubscribe: <${safe(m.unsubscribeUrl)}>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `X-Dispatch-Ref: ${safe(m.deliveryRef)}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  return [
    ...headers,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrap76(Buffer.from(m.text, "utf8").toString("base64")),
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrap76(Buffer.from(m.html, "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export async function gmailSend(accessToken: string, mime: string): Promise<{ id: string; threadId: string }> {
  const res = await googleCall("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", accessToken, {
    method: "POST",
    body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
    timeoutMs: 25_000,
  });
  if (!res.ok) await classify(res, "Gmail send");
  return (await res.json()) as { id: string; threadId: string };
}

export async function gmailProfile(accessToken: string): Promise<{ emailAddress: string; messagesTotal: number }> {
  const res = await googleCall("https://gmail.googleapis.com/gmail/v1/users/me/profile", accessToken, { timeoutMs: 10_000 });
  if (!res.ok) await classify(res, "Gmail profile");
  return (await res.json()) as { emailAddress: string; messagesTotal: number };
}

export async function gmailList(accessToken: string, q: string, max = 50): Promise<Array<{ id: string; threadId: string }>> {
  const res = await googleCall(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(max) })}`, accessToken, { timeoutMs: 15_000 });
  if (!res.ok) await classify(res, "Gmail list");
  return ((await res.json()) as { messages?: Array<{ id: string; threadId: string }> }).messages ?? [];
}

export interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export async function gmailGet(accessToken: string, id: string): Promise<{ id: string; threadId: string; payload: GmailPart; internalDate?: string }> {
  const res = await googleCall(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, accessToken, { timeoutMs: 15_000 });
  if (!res.ok) await classify(res, "Gmail get");
  return (await res.json()) as { id: string; threadId: string; payload: GmailPart; internalDate?: string };
}

// ---------- Calendar ----------

export interface CalendarEventInput {
  id: string; // client-specified (base32hex) → retries can't create duplicates
  summary: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  reminderMinutes: number;
  withMeet: boolean;
}

export async function calendarInsert(accessToken: string, e: CalendarEventInput): Promise<{ id: string; htmlLink: string; hangoutLink?: string }> {
  const body: Record<string, unknown> = {
    id: e.id,
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start, timeZone: e.timeZone },
    end: { dateTime: e.end, timeZone: e.timeZone },
    attendees: e.attendees.map((email) => ({ email })),
    reminders: e.reminderMinutes > 0 ? { useDefault: false, overrides: [{ method: "popup", minutes: e.reminderMinutes }] } : { useDefault: false, overrides: [] },
  };
  if (e.withMeet) body.conferenceData = { createRequest: { requestId: e.id, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  const params = new URLSearchParams({ sendUpdates: e.attendees.length ? "all" : "none", conferenceDataVersion: e.withMeet ? "1" : "0" });
  const res = await googleCall(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, accessToken, {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 20_000,
  });
  if (!res.ok) await classify(res, "Calendar");
  return (await res.json()) as { id: string; htmlLink: string; hangoutLink?: string };
}

export async function calendarGet(accessToken: string, id: string): Promise<{ id: string; htmlLink: string; hangoutLink?: string; status: string }> {
  const res = await googleCall(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, accessToken, { timeoutMs: 15_000 });
  if (!res.ok) await classify(res, "Calendar");
  return (await res.json()) as { id: string; htmlLink: string; hangoutLink?: string; status: string };
}

export async function calendarFreeBusy(accessToken: string, timeMin: string, timeMax: string, timeZone: string): Promise<Array<{ start: string; end: string }>> {
  const res = await googleCall("https://www.googleapis.com/calendar/v3/freeBusy", accessToken, {
    method: "POST",
    body: JSON.stringify({ timeMin, timeMax, timeZone, items: [{ id: "primary" }] }),
    timeoutMs: 15_000,
  });
  if (!res.ok) await classify(res, "Calendar availability");
  const data = (await res.json()) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
  return data.calendars?.primary?.busy ?? [];
}

// Base32hex event ID derived from our action ID (Calendar requires [a-v0-9]{5,1024}).
export function calendarEventId(actionId: string): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = "";
  for (const byte of Buffer.from(actionId, "utf8")) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return `dsp${out}`.slice(0, 1024);
}
