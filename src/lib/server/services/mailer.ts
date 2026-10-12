import "server-only";
import { config } from "../config";
import type { Db } from "../db/client";
import { buildMime, gmailSend } from "../providers/google";
import { resendSend, ResendError } from "../providers/resend";
import { getGoogleConnection, googleAccessToken, hasFeature } from "./google-auth";

// Provider-neutral sending interface used only by services/delivery.ts.
// Errors carry a `kind` (AUTH | QUOTA | PERMANENT | TEMPORARY | UNKNOWN …)
// that delivery maps to recipient states.

export interface OutboundEmail {
  fromName: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  deliveryRef: string;
}

export interface Mailer {
  provider: "gmail" | "resend";
  intervalMs: number;
  send(m: OutboundEmail): Promise<{ id: string; threadId?: string | null }>;
}

export interface MailerReadiness {
  ok: boolean;
  provider: "gmail" | "resend";
  sender: string | null;
  issue: string;
}

// "Name <addr>" → keep as-is; bare address → prefix the configured From name.
export function resendFrom(fromName: string, configured: string): string {
  return configured.includes("<") ? configured : `${fromName.replace(/[<>"]/g, "")} <${configured}>`;
}

function senderAddress(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

export async function mailerReadiness(db: Db): Promise<MailerReadiness> {
  const provider = config.emailProvider();
  if (provider === "resend") {
    const r = config.resend();
    return r.ok
      ? { ok: true, provider, sender: senderAddress(r.value!.from), issue: "" }
      : { ok: false, provider, sender: null, issue: `Resend isn't configured (${r.missing.join(", ")}).` };
  }
  const google = await getGoogleConnection(db);
  if (hasFeature(google, "send")) return { ok: true, provider, sender: google!.accountEmail, issue: "" };
  return {
    ok: false,
    provider,
    sender: google?.accountEmail ?? null,
    issue: !google
      ? "No email provider is connected. Add a Resend API key, or connect Gmail in Settings."
      : google.status !== "READY"
        ? `Gmail needs to be reconnected (${google.lastError ?? "access expired"}).`
        : "The connected Google account hasn't granted permission to send email.",
  };
}

export async function getMailer(db: Db, provider: "gmail" | "resend" = config.emailProvider()): Promise<Mailer> {
  if (provider === "resend") {
    const r = config.resend();
    if (!r.ok) throw new ResendError(`Resend isn't configured (${r.missing.join(", ")}).`, "AUTH");
    const { apiKey, from } = r.value!;
    return {
      provider,
      intervalMs: 150, // under Resend's default 10 requests/second
      async send(m) {
        const msg = {
          from: resendFrom(m.fromName, from),
          to: m.to,
          subject: m.subject,
          html: m.html,
          text: m.text,
          replyTo: m.replyTo,
          headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Dispatch-Ref": m.deliveryRef },
          idempotencyKey: m.deliveryRef,
          tags: [{ name: "delivery", value: m.deliveryRef }],
        };
        try {
          return await resendSend(apiKey, msg);
        } catch (e) {
          // With the same Idempotency-Key, retrying an unknown outcome once is
          // safe: Resend returns the original result instead of re-sending.
          if (e instanceof ResendError && e.kind === "UNKNOWN" && e.status !== 409) return resendSend(apiKey, msg);
          throw e;
        }
      },
    };
  }
  const { token, email } = await googleAccessToken(db, "send");
  return {
    provider,
    intervalMs: 1100, // Gmail API: ~60 sends/minute per user
    async send(m) {
      const mime = buildMime({ fromName: m.fromName, fromEmail: email ?? "me", to: m.to, replyTo: m.replyTo, subject: m.subject, html: m.html, text: m.text, unsubscribeUrl: m.unsubscribeUrl, deliveryRef: m.deliveryRef });
      return gmailSend(token, mime);
    },
  };
}
