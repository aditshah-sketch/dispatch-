// Renders the newsletter email (HTML + plain text) from an immutable snapshot.
// Used for the dashboard "exact email preview" and for the real send, so what
// Shreya approves is byte-for-byte what recipients get (apart from their own
// unsubscribe link).

import { topicLabel } from "./topics";
import { isHttpUrl } from "./url";
import type { EditionSnapshot } from "./types";

export interface EmailBranding {
  newsletterName: string;
  fromName: string;
  footer: string;
}

export const DEFAULT_BRANDING: EmailBranding = {
  newsletterName: "The Dispatch",
  fromName: "Shreya at The Dispatch",
  footer: "You're receiving this because you subscribed to The Dispatch, a weekly briefing on India's startup ecosystem.",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string): string | null {
  return isHttpUrl(url) ? escapeHtml(url) : null;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmail(
  snap: EditionSnapshot,
  brand: EmailBranding,
  opts: { unsubscribeUrl: string },
): RenderedEmail {
  const issue = snap.issueNumber ? `Issue ${snap.issueNumber} · ` : "";
  const heading = `${issue}${dateLabel(snap.publishDate)}`;
  const unsub = safeHref(opts.unsubscribeUrl);

  const storiesHtml = snap.stories
    .map((s, i) => {
      const href = safeHref(s.url);
      const title = escapeHtml(s.headline);
      const linkedTitle = href
        ? `<a href="${href}" style="color:#1d1b18;text-decoration:none;">${title}</a>`
        : title;
      return `
<tr><td style="padding:24px 0;border-top:1px solid #e4ded3;">
  <div style="font:600 11px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#9c3d1f;margin-bottom:6px;">${i + 1} · ${escapeHtml(topicLabel(s.topic))}</div>
  <h2 style="margin:0 0 6px 0;font:600 20px/1.3 Georgia,'Times New Roman',serif;color:#1d1b18;">${linkedTitle}</h2>
  <div style="font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6e675d;margin-bottom:10px;">${escapeHtml(s.publisher)}${href ? ` · <a href="${href}" style="color:#9c3d1f;">Read the story</a>` : ""}</div>
  <div style="font:16px/1.6 Georgia,'Times New Roman',serif;color:#2b2824;">${paragraphs(s.commentary)}</div>
</td></tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${escapeHtml(snap.subject)}</title></head>
<body style="margin:0;padding:0;background:#f7f4ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ee;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf9;border:1px solid #e4ded3;border-radius:6px;">
<tr><td style="padding:28px 28px 8px 28px;">
  <div style="font:700 26px/1.2 Georgia,'Times New Roman',serif;color:#1d1b18;">${escapeHtml(brand.newsletterName)}</div>
  <div style="font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6e675d;margin-top:4px;">${escapeHtml(heading)}</div>
</td></tr>
${snap.intro.trim() ? `<tr><td style="padding:12px 28px 4px 28px;font:16px/1.6 Georgia,'Times New Roman',serif;color:#2b2824;">${paragraphs(snap.intro)}</td></tr>` : ""}
<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${storiesHtml}</table></td></tr>
<tr><td style="padding:20px 28px 28px 28px;border-top:1px solid #e4ded3;font:12px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6e675d;">
  ${escapeHtml(brand.footer)}<br>
  ${unsub ? `<a href="${unsub}" style="color:#6e675d;">Unsubscribe</a>` : ""}
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `${brand.newsletterName} — ${heading}`,
    "",
    snap.intro.trim(),
    snap.intro.trim() ? "" : null,
    ...snap.stories.flatMap((s, i) => [
      `${i + 1}. ${s.headline}`,
      `${s.publisher} — ${s.url}`,
      "",
      s.commentary.trim(),
      "",
      "—",
      "",
    ]),
    brand.footer,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { subject: snap.subject, html, text };
}
