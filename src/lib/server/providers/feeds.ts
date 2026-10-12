import "server-only";
import { XMLParser } from "fast-xml-parser";
import { decodeEntities, htmlToText, truncate } from "../../domain/text";
import { isHttpUrl } from "../../domain/url";
import { apiFetch, safeFetch } from "../net/safe-fetch";

// Collected item before normalisation and storage.
export interface FeedItem {
  title: string;
  url: string;
  description: string | null;
  content: string | null; // full text when the feed provides it
  author: string | null;
  publishedAt: string | null;
  publisher: string | null;
  dateNote: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  // Defensive limits against hostile feeds.
  stopNodes: ["*.script", "*.style"],
});

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return text(o["#text"]);
    if ("@href" in o) return text(o["@href"]);
  }
  return "";
}

function arr<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

export function normaliseDate(raw: string | null | undefined, now = Date.now()): { iso: string | null; note: string | null } {
  if (!raw) return { iso: null, note: "Publication date missing in feed" };
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return { iso: null, note: "Unparseable publication date" };
  if (t > now + 36 * 3_600_000) return { iso: null, note: "Publication date is in the future; ignored" };
  if (t < Date.UTC(2000, 0, 1)) return { iso: null, note: "Implausible publication date; ignored" };
  return { iso: new Date(t).toISOString(), note: null };
}

export function parseFeed(xml: string): { title: string | null; items: FeedItem[] } {
  if (xml.length > 5_000_000) throw new Error("Feed is too large");
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as Record<string, unknown> | undefined;
  const rdf = (doc["rdf:RDF"] ?? doc.RDF) as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;

  const out: FeedItem[] = [];
  let title: string | null = null;

  const pushItem = (raw: {
    title: string;
    link: string;
    description?: string;
    content?: string;
    author?: string;
    date?: string;
    source?: string;
  }) => {
    const t = decodeEntities(htmlToText(raw.title)).trim();
    const link = raw.link.trim();
    if (!t || !isHttpUrl(link)) return;
    const d = normaliseDate(raw.date);
    const desc = raw.description ? truncate(htmlToText(raw.description), 1500) : null;
    const content = raw.content ? htmlToText(raw.content) : null;
    out.push({
      title: truncate(t, 300),
      url: link,
      description: desc || null,
      content: content && content.length > 400 ? truncate(content, 20000) : null,
      author: raw.author ? truncate(htmlToText(raw.author), 120) : null,
      publishedAt: d.iso,
      publisher: raw.source ? truncate(htmlToText(raw.source), 120) : null,
      dateNote: d.note,
    });
  };

  if (rss || rdf) {
    const channel = (rss?.channel ?? rdf?.channel) as Record<string, unknown> | undefined;
    title = channel ? text(channel.title) || null : null;
    const items = arr((channel?.item ?? rdf?.item) as unknown[]);
    for (const it of items.slice(0, 200) as Record<string, unknown>[]) {
      pushItem({
        title: text(it.title),
        link: text(it.link) || (text(it.guid).startsWith("http") ? text(it.guid) : ""),
        description: text(it.description),
        content: text(it["content:encoded"]),
        author: text(it["dc:creator"]) || text(it.author),
        date: text(it.pubDate) || text(it["dc:date"]),
        source: text(it.source),
      });
    }
  } else if (atom) {
    title = text(atom.title) || null;
    for (const e of arr(atom.entry as unknown[]).slice(0, 200) as Record<string, unknown>[]) {
      const links = arr(e.link as unknown[]) as Record<string, unknown>[];
      const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
      pushItem({
        title: text(e.title),
        link: alt ? text(alt["@href"]) : "",
        description: text(e.summary),
        content: text(e.content),
        author: text((e.author as Record<string, unknown> | undefined)?.name),
        date: text(e.published) || text(e.updated),
      });
    }
  } else {
    throw new Error("Not an RSS or Atom feed");
  }
  return { title, items: out };
}

export async function fetchFeed(url: string): Promise<{ title: string | null; items: FeedItem[] }> {
  const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 4_000_000 });
  if (res.status >= 400) throw new Error(`Feed returned HTTP ${res.status}`);
  if (/text\/html/i.test(res.contentType) && !/<(rss|feed|rdf:RDF)[\s>]/i.test(res.body.slice(0, 2000))) {
    throw new Error("URL returned a web page, not a feed");
  }
  return parseFeed(res.body);
}

// ---------- Google News search (query-based discovery, no key) ----------
// Used for news queries when no GNews key is configured. Titles arrive as
// "Headline - Publisher" with the publisher in <source>; links redirect
// through news.google.com, so full text isn't retrieved for these items.

export function googleNewsSearchUrl(query: string): string {
  const q = `${query} when:7d`;
  return `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: "en-IN", gl: "IN", ceid: "IN:en" })}`;
}

export async function searchGoogleNews(query: string, fromIso: string): Promise<NewsQueryResult> {
  const res = await safeFetch(googleNewsSearchUrl(query), { timeoutMs: 15_000, maxBytes: 3_000_000 });
  if (res.status >= 400) throw new Error(`Google News returned HTTP ${res.status}`);
  const from = Date.parse(fromIso);
  const items = parseFeed(res.body)
    .items.filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= from)
    .slice(0, 25)
    .map((i) => {
      const suffix = i.publisher ? ` - ${i.publisher}` : "";
      const title = suffix && i.title.endsWith(suffix) ? i.title.slice(0, -suffix.length).trim() : i.title;
      // Google's description only repeats the headline and source; drop it.
      return { ...i, title, description: null, content: null };
    });
  return { items, note: null };
}

// ---------- GNews (news search API) ----------
// https://docs.gnews.io/ — `apikey` query parameter; free plan has a 12-hour
// delay, 10 articles per request and is for non-commercial use.

export interface NewsQueryResult {
  items: FeedItem[];
  note: string | null;
}

export async function searchGNews(apiKey: string, query: string, fromIso: string): Promise<NewsQueryResult> {
  const params = new URLSearchParams({ q: query, lang: "en", country: "in", max: "10", sortby: "publishedAt", from: fromIso.replace(/\.\d{3}Z$/, "Z") });
  const res = await apiFetch(`https://gnews.io/api/v4/search?${params}&apikey=${encodeURIComponent(apiKey)}`, { timeoutMs: 15_000 });
  const body = (await res.json().catch(() => null)) as { articles?: Array<Record<string, unknown>>; errors?: unknown } | null;
  if (!res.ok) {
    const msg = Array.isArray(body?.errors) ? String(body!.errors[0]) : JSON.stringify(body?.errors ?? res.statusText);
    throw new Error(res.status === 403 || res.status === 429 ? `GNews quota or plan limit reached (${res.status}): ${msg}` : `GNews error ${res.status}: ${msg}`);
  }
  const items: FeedItem[] = [];
  for (const a of body?.articles ?? []) {
    const url = String(a.url ?? "");
    if (!isHttpUrl(url) || !a.title) continue;
    const d = normaliseDate(String(a.publishedAt ?? ""));
    items.push({
      title: truncate(String(a.title), 300),
      url,
      description: a.description ? truncate(String(a.description), 1500) : null,
      // GNews returns truncated content on lower plans — treat it as a summary.
      content: null,
      author: null,
      publishedAt: d.iso,
      publisher: (a.source as { name?: string } | undefined)?.name ?? null,
      dateNote: d.note,
    });
  }
  return { items, note: null };
}
