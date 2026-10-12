// Conservative URL normalisation for article identity.
// Removes only parameters known to be tracking noise; anything else (e.g. an
// `id=` or `story=` parameter) may identify a distinct article and is kept.

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "twclid", "igshid",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "ref", "ref_src", "ref_url",
  "cmpid", "ito", "ncid", "sr_share", "spm", "share", "s_cid", "rss", "feed",
  "fromrss", "trk", "trkcampaign", "ocid", "guccounter", "_ga", "_gl",
]);

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const params = [...u.searchParams.entries()]
    .filter(([k]) => {
      const key = k.toLowerCase();
      return !key.startsWith("utm_") && !TRACKING_PARAMS.has(key);
    })
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));

  let path = u.pathname.replace(/\/{2,}/g, "/");
  // AMP variants of the same article.
  path = path.replace(/\/amp\/?$/i, "/").replace(/\.amp(\.html?)?$/i, "$1");
  if (path.length > 1) path = path.replace(/\/+$/, "");

  const query = params.length
    ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  // Scheme is dropped: http/https copies of one article are the same article.
  return `${host}${path}${query}`;
}

export function hostnameOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
