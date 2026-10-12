// Deterministic text features used for duplicate detection, event clustering
// and history comparison. No AI involved.

const STOPWORDS = new Set(
  (
    "a an the and or but of in on at to for from by with as is are was were be been being it its this that these those " +
    "has have had will would can could should may might into over after before about than then so such via amid against " +
    "new says said report reports reportedly per cent percent its their his her they them we our you your i india indian " +
    "startup startups company firm more most up down out how why what who when where which while also just now year years"
  ).split(" "),
);

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

export function tokenize(s: string): string[] {
  return normalizeText(s)
    .replace(/[^a-z0-9₹$%.\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s).map(stem));
}

// Very light stemming so "raises"/"raised"/"raise" collapse together.
function stem(t: string): string {
  if (/^\d/.test(t)) return t;
  return t.replace(/(ings|ing|ed|es|s)$/, "").slice(0, 12) || t;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Overlap coefficient — better than Jaccard when one headline is much longer.
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

const ENTITY_STOP = new Set([
  "The", "A", "An", "In", "On", "At", "For", "With", "How", "Why", "What", "Who", "When", "As", "After", "Before",
  "India", "Indian", "Startup", "Startups", "Exclusive", "Breaking", "Report", "Sources", "Funding", "Series",
  "Inc", "Ltd", "Pvt", "CEO", "IPO", "Rs", "Crore", "Million", "Billion", "Here", "This", "That", "From", "To",
  "Q1", "Q2", "Q3", "Q4", "FY", "FY25", "FY26", "FY27", "Seed", "Pre", "Sample", "Its", "Their", "Big", "New",
  // Sector words are not companies; treating them as entities would flag
  // every edtech story because an earlier edtech story ran.
  "Edtech", "EdTech", "Fintech", "FinTech", "Agritech", "AgriTech", "Healthtech", "HealthTech", "Insurtech", "InsurTech",
  "Proptech", "Deeptech", "SaaS", "EV", "D2C", "B2B", "B2C", "AI", "GenAI", "Logistics", "Unicorn", "Soonicorn",
  "Govt", "Government", "Centre", "Union", "State", "Budget", "Exclusive:", "Explained", "Opinion", "Analysis",
]);

const UNITS = new Set(["cr", "crore", "crores", "mn", "bn", "lakh", "lakhs", "rs", "inr", "usd", "million", "billion", "pc", "yoy"]);

// Proper-noun-ish phrases from headline casing, e.g. "Kirana Cloud", "RBI".
// Imperfect by design; used as one signal among several.
export function extractEntities(headline: string): string[] {
  const words = headline.replace(/[’']s\b/g, "").split(/[^A-Za-z0-9&.-]+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.join(" ").toLowerCase());
    run = [];
  };
  for (const w of words) {
    const clean = w.replace(/[.]+$/, "");
    // Numbers and currency units ("110", "Cr", "Mn") are never company names.
    if (/^\d/.test(clean) || UNITS.has(clean.toLowerCase())) {
      flush();
      continue;
    }
    const capitalised = /^[A-Z][A-Za-z0-9&.-]*$/.test(clean) || /^[A-Z0-9]{2,}$/.test(clean);
    if (capitalised && !ENTITY_STOP.has(clean)) run.push(clean);
    else flush();
  }
  flush();
  return [...new Set(out.filter((e) => e.length > 2))];
}

export type EventType =
  | "funding" | "acquisition" | "ipo" | "layoffs" | "launch" | "regulation" | "results" | "leadership" | "shutdown" | "other";

const EVENT_RULES: Array<[EventType, RegExp]> = [
  ["ipo", /\b(ipo|drhp|listing|lists on|public offer)\b/i],
  ["acquisition", /\b(acquir\w*|acquisition|merger|merges?|buyout|takeover)\b/i],
  ["layoffs", /\b(layoffs?|lays? off|laid off|job cuts|cuts? \d+ jobs|downsiz\w*|fires?)\b/i],
  ["shutdown", /\b(shut(s|ting)? down|shutdown|winds? (up|down)|closes operations)\b/i],
  ["funding", /\b(raises?|raised|raising|funding|series [a-f]|seed round|pre-seed|bags?|secures?|investment from|led by)\b/i],
  ["results", /\b(revenue|loss|profit|fy\d{2}|financials|results|turnover|ebitda)\b/i],
  ["regulation", /\b(rbi|sebi|meity|regulat\w*|policy|ban|rules|guidelines|notice|penalty|fine[ds]?)\b/i],
  ["leadership", /\b(appoints?|names? .* (ceo|cfo|cto)|steps down|resigns?|exits as|new ceo)\b/i],
  ["launch", /\b(launch\w*|unveils?|rolls? out|introduces?|debuts?|expands? to)\b/i],
];

export function classifyEvent(text: string): EventType {
  for (const [type, re] of EVENT_RULES) if (re.test(text)) return type;
  return "other";
}

// Money / percentage mentions normalised to comparable tokens:
// "$25 million" → "usd25m", "Rs 200 crore" / "₹200 Cr" → "inr200cr".
export function extractAmounts(text: string): string[] {
  const out = new Set<string>();
  const t = normalizeText(text).replace(/,/g, "");
  const usd = /(?:\$|usd\s?)(\d+(?:\.\d+)?)\s?(million|mn|m|billion|bn|b)\b/g;
  const inr = /(?:₹|rs\.?\s?|inr\s?)(\d+(?:\.\d+)?)\s?(crore|cr|lakh|lakhs)\b/g;
  let m: RegExpExecArray | null;
  while ((m = usd.exec(t))) out.add(`usd${Number(m[1])}${m[2].startsWith("b") ? "b" : "m"}`);
  while ((m = inr.exec(t))) out.add(`inr${Number(m[1])}${m[2].startsWith("l") ? "l" : "cr"}`);
  return [...out];
}

// 64-bit FNV-1a, hex. Synchronous and identical in browser and server, used for
// content fingerprints and revision content hashes (integrity, not security).
export function fnv1a64(input: string): string {
  let h = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

// Fingerprint of the normalised lead text, catching syndicated copies that
// live at different URLs.
export function contentFingerprint(headline: string, body: string | null | undefined): string {
  const lead = tokenize(`${headline} ${(body ?? "").slice(0, 600)}`).join(" ");
  return fnv1a64(lead);
}

export function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  // Avoid splitting on common abbreviations and decimals.
  const protectedText = cleaned
    .replace(/\b(Rs|Mr|Ms|Dr|Inc|Ltd|Co|vs|St|No|Pvt|approx|est)\./gi, "$1\u0000")
    .replace(/(\d)\.(\d)/g, "$1\u0001$2")
    .replace(/\b([A-Z])\.(?=[A-Z]\.)/g, "$1\u0000");
  return protectedText
    .split(/(?<=[.!?])\s+(?=["'“‘(]?[A-Z0-9₹$])/)
    .map((s) => s.replace(/\u0000/g, ".").replace(/\u0001/g, ".").trim())
    .filter(Boolean);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

// Strip tags/entities from feed HTML snippets into plain text.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|iframe|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", rupee: "₹",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}
