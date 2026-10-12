import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Outbound fetch for URLs that come from configuration or source content
// (RSS feeds, article links). Blocks private / loopback / link-local /
// metadata destinations, re-validates every redirect hop, and bounds time and
// response size. Fixed API hosts (Gemini, Telegram, Google) use plain fetch.

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Blocked(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return true; // link-local
  if (x.startsWith("fc") || x.startsWith("fd")) return true; // unique local
  if (x.startsWith("ff")) return true; // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new UnsafeUrlError("Local and internal hosts are not allowed");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError("Private or reserved addresses are not allowed");
    return u;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new UnsafeUrlError("Host resolves to a private or reserved address");
  }
  return u;
}

export interface SafeFetchResult {
  status: number;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

export async function safeFetch(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; headers?: Record<string, string> } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  let current = raw;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 4); hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: "manual",
      signal: deadline,
      headers: {
        "user-agent": "TheDispatchBot/1.0 (+newsletter research; respects robots and paywalls)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
        ...opts.headers,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new Error(`Redirect without location (${res.status})`);
      current = new URL(loc, url).toString();
      continue;
    }
    const { text, truncated } = await readLimited(res, maxBytes);
    return { status: res.status, url: url.toString(), contentType: res.headers.get("content-type") ?? "", body: text, truncated };
  }
  throw new Error("Too many redirects");
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}

// For fixed, trusted API hosts: plain fetch with a timeout and a clear error.
export async function apiFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  return fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
}
