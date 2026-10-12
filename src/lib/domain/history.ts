import { compareEvents, eventFeatures, type EventFeatures } from "./clustering";

// A story that went out in an actually-published edition (or was imported
// from Shreya's archive). Drafts and unapproved editions never become refs.
export interface CoveredRef {
  editionId: string;
  publishDate: string;
  normalizedUrl: string;
  headline: string;
  description?: string | null;
  publishedAt?: string | null;
}

export type HistoryVerdict =
  | { status: "CLEAR" }
  | { status: "EXCLUDED"; reason: string; ref: CoveredRef }
  | { status: "FLAGGED"; reason: string; ref: CoveredRef };

export const HISTORY_DEPTH = 4;

// Picks the refs from the previous N published editions (by publish date),
// excluding the edition under construction.
export function refsFromPreviousEditions(
  refs: CoveredRef[],
  currentPublishDate: string,
  depth = HISTORY_DEPTH,
): { refs: CoveredRef[]; editions: string[] } {
  const editionDates = new Map<string, string>();
  for (const r of refs) if (r.publishDate < currentPublishDate) editionDates.set(r.editionId, r.publishDate);
  const editions = [...editionDates.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, depth)
    .map(([id]) => id);
  const keep = new Set(editions);
  return { refs: refs.filter((r) => keep.has(r.editionId)), editions };
}

export function checkAgainstHistory(
  article: { normalizedUrl: string; headline: string; description?: string | null; publishedAt?: string | null },
  refs: CoveredRef[],
  precomputed?: Map<CoveredRef, EventFeatures>,
): HistoryVerdict {
  const features = eventFeatures(article);
  let flagged: HistoryVerdict | null = null;
  for (const ref of refs) {
    if (ref.normalizedUrl && ref.normalizedUrl === article.normalizedUrl) {
      return { status: "EXCLUDED", reason: `Same article ran in the ${formatDate(ref.publishDate)} edition`, ref };
    }
    const refFeatures = precomputed?.get(ref) ?? eventFeatures(ref);
    // Past coverage can be weeks old, so the time window is wide here; the
    // event-type and amount checks keep a new development of the same company eligible.
    const match = compareEvents(features, refFeatures, 45, true);
    if (match.same) {
      return {
        status: "EXCLUDED",
        reason: `Same development covered on ${formatDate(ref.publishDate)}: “${ref.headline}” (${match.reason.toLowerCase()})`,
        ref,
      };
    }
    if (match.sharedEntity && !flagged) {
      flagged = {
        status: "FLAGGED",
        reason: `${titleCase(match.sharedEntity)} was covered on ${formatDate(ref.publishDate)} (“${ref.headline}”). This looks like a different development — confirm it is genuinely new.`,
        ref,
      };
    }
  }
  return flagged ?? { status: "CLEAR" };
}

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${month} ${y}`;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function historyDepthLabel(checked: number, depth = HISTORY_DEPTH): string {
  if (checked === 0) return "No published editions yet — nothing to compare against";
  if (checked < depth) return `Checked against ${checked} of ${depth} editions (only ${checked} published so far)`;
  return `Checked against the previous ${depth} published editions`;
}
