import "server-only";
import { decodeEntities, htmlToText } from "../../domain/text";
import { isHttpUrl } from "../../domain/url";
import { apiFetch, assertPublicUrl } from "../net/safe-fetch";

// ScrapingBee retrieves the page behind a discovered article URL when the
// feed text is too thin. It never replaces RSS / news search as the discovery
// mechanism. JS rendering (5 credits vs 1) is off by default. Paywalls and
// logins are not bypassed: such pages are recorded as BLOCKED.

export interface PageResult {
  status: "EXTRACTED" | "PARTIAL" | "FAILED" | "BLOCKED";
  text: string | null;
  note: string | null;
  credits: number | null;
}

const PAYWALL = /(subscribe to (continue|read)|already a subscriber|sign in to (continue|read)|this (article|story) is for (subscribers|members)|paywall|premium (article|story))/i;

export async function fetchArticlePage(apiKey: string, url: string, opts: { renderJs: boolean; timeoutMs?: number }): Promise<PageResult> {
  if (!isHttpUrl(url)) return { status: "FAILED", text: null, note: "Not an http(s) URL", credits: null };
  try {
    await assertPublicUrl(url); // don't ask a proxy to fetch internal addresses either
  } catch (e) {
    return { status: "FAILED", text: null, note: (e as Error).message, credits: null };
  }
  const params = new URLSearchParams({
    url,
    render_js: opts.renderJs ? "true" : "false",
    block_resources: "true",
    timeout: String(opts.timeoutMs ?? 20_000),
  });
  let res: Response;
  try {
    res = await apiFetch(`https://app.scrapingbee.com/api/v1/?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: (opts.timeoutMs ?? 20_000) + 5_000,
    });
  } catch (e) {
    return { status: "FAILED", text: null, note: `ScrapingBee request failed: ${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`, credits: null };
  }
  const credits = Number(res.headers.get("spb-cost")) || null;
  const initial = Number(res.headers.get("spb-initial-status-code")) || res.status;
  if (res.status === 401) return { status: "FAILED", text: null, note: "ScrapingBee rejected the API key or the account is out of credits", credits };
  if (res.status === 429) return { status: "FAILED", text: null, note: "ScrapingBee concurrency limit reached", credits };
  if (!res.ok) {
    const blocked = initial === 401 || initial === 403;
    return { status: blocked ? "BLOCKED" : "FAILED", text: null, note: `Source page returned HTTP ${initial}`, credits };
  }
  const html = (await res.text()).slice(0, 3_000_000);
  const extracted = extractArticleText(html);
  if (PAYWALL.test(html.slice(0, 200_000)) && extracted.length < 1500) {
    return { status: "BLOCKED", text: extracted || null, note: "Page appears to be paywalled; only the public portion was used", credits };
  }
  if (extracted.length < 400) return { status: "PARTIAL", text: extracted || null, note: "Little readable text on the page", credits };
  return { status: "EXTRACTED", text: extracted, note: null, credits };
}

// Deterministic readable-text extraction: prefer <article>/<main>, then
// collect paragraph text; drop navigation, scripts and boilerplate.
export function extractArticleText(html: string): string {
  const cleaned = html
    .replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const scope =
    /<article[\s>][\s\S]*?<\/article>/i.exec(cleaned)?.[0] ??
    /<main[\s>][\s\S]*?<\/main>/i.exec(cleaned)?.[0] ??
    cleaned;
  const paras = [...scope.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)]
    .map((m) => decodeEntities(htmlToText(m[0])).replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40 && !/^(advertisement|also read|read more|click here|follow us)/i.test(p));
  return paras.join("\n\n").slice(0, 20_000);
}
