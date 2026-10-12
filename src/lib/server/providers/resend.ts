import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { apiFetch } from "../net/safe-fetch";

// Resend email API (resend.com/docs/api-reference/emails/send-email).
// - One recipient per request, so subscriber addresses are never exposed.
// - `Idempotency-Key` (kept 24h by Resend) = our delivery ID, so retrying a
//   request whose outcome is unknown cannot produce a second email.
// - Default rate limit: 10 requests/second per team.

export class ResendError extends Error {
  constructor(
    message: string,
    readonly kind: "AUTH" | "QUOTA" | "PERMANENT" | "TEMPORARY" | "UNKNOWN",
    readonly status = 0,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  headers: Record<string, string>;
  idempotencyKey: string;
  tags?: Array<{ name: string; value: string }>;
}

export async function resendSend(apiKey: string, m: ResendMessage): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await apiFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey.slice(0, 256) },
      body: JSON.stringify({
        from: m.from,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        text: m.text,
        reply_to: m.replyTo || undefined,
        headers: m.headers,
        tags: m.tags,
      }),
      timeoutMs: 20_000,
    });
  } catch (e) {
    // The request may or may not have reached Resend.
    throw new ResendError(`No response from Resend (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`, "UNKNOWN");
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
  if (res.ok && body.id) return { id: body.id };
  const msg = `Resend: ${body.message ?? res.statusText} (${body.name ?? res.status})`;
  if (res.status === 401 || res.status === 403) throw new ResendError(msg, "AUTH", res.status);
  if (res.status === 429) throw new ResendError(msg, "QUOTA", res.status); // rate limit or daily/monthly quota
  if (res.status >= 500) throw new ResendError(msg, "TEMPORARY", res.status);
  if (res.status === 409) throw new ResendError(msg, "UNKNOWN", res.status); // idempotency conflict: same key, different payload
  throw new ResendError(msg, "PERMANENT", res.status); // 400/422: invalid recipient, unverified domain…
}

// Safe connection test: reads domains, never sends.
export async function resendCheck(apiKey: string, from: string): Promise<string> {
  const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase() ?? "";
  const res = await apiFetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${apiKey}` }, timeoutMs: 15_000 });
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ name: string; status: string }>; name?: string; message?: string };
  if (res.status === 401 && body.name === "restricted_api_key") {
    return `API key accepted (sending-only key, so domain status can't be read). Sender: ${from}. No email was sent.`;
  }
  if (!res.ok) throw new ResendError(`Resend: ${body.message ?? res.statusText}`, res.status === 401 || res.status === 403 ? "AUTH" : "TEMPORARY", res.status);
  if (domain === "resend.dev") return "Key valid. Using Resend's test sender (onboarding@resend.dev): it can only deliver to your own Resend account email. Verify a domain to send to subscribers.";
  const d = body.data?.find((x) => x.name.toLowerCase() === domain);
  if (!d) throw new ResendError(`Key valid, but the sender domain “${domain}” isn't added in Resend. Add and verify it under Domains.`, "PERMANENT");
  if (d.status !== "verified") throw new ResendError(`Key valid, but the domain “${domain}” is ${d.status}. Finish DNS verification in Resend before sending.`, "PERMANENT");
  return `Key valid; ${domain} is verified. No email was sent.`;
}

// Svix-style webhook signature (docs.svix.com/receiving/verifying-payloads/how-manual):
// HMAC-SHA256 over "id.timestamp.rawBody" with the base64 secret after "whsec_".
export function verifyResendWebhook(secret: string, headers: Headers, rawBody: string, toleranceSeconds = 300): boolean {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sigHeader = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigHeader.split(" ").some((part) => {
    const [, sig] = part.split(",");
    if (!sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
