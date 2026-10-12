import {
  classifyEvent,
  extractAmounts,
  extractEntities,
  jaccard,
  overlap,
  tokenSet,
  type EventType,
} from "./text";

// Features describing "what happened", used to decide whether two articles
// cover the same event. Shared by clustering and history comparison.
export interface EventFeatures {
  headlineTokens: Set<string>;
  leadTokens: Set<string>;
  entities: string[];
  eventType: EventType;
  amounts: string[];
  publishedAt: number | null;
}

export function eventFeatures(input: {
  headline: string;
  description?: string | null;
  publishedAt?: string | null;
}): EventFeatures {
  const lead = `${input.headline} ${(input.description ?? "").slice(0, 300)}`;
  return {
    headlineTokens: tokenSet(input.headline),
    leadTokens: tokenSet(lead),
    entities: extractEntities(input.headline),
    // Classify on the headline first: descriptions often mention unrelated
    // background ("…which raised funding last year").
    eventType: pickEventType(input.headline, input.description ?? ""),
    amounts: extractAmounts(lead),
    publishedAt: input.publishedAt ? Date.parse(input.publishedAt) : null,
  };
}

function pickEventType(headline: string, description: string): EventType {
  const fromHeadline = classifyEvent(headline);
  return fromHeadline !== "other" ? fromHeadline : classifyEvent(description.slice(0, 200));
}

export interface EventMatch {
  same: boolean;
  sharedEntity: string | null;
  reason: string;
  score: number;
}

const DAY = 86_400_000;

function sharedEntityOf(a: EventFeatures, b: EventFeatures): string | null {
  for (const ea of a.entities) {
    for (const eb of b.entities) {
      if (ea === eb || (ea.length > 3 && eb.length > 3 && (ea.includes(eb) || eb.includes(ea)))) return ea;
    }
  }
  return null;
}

// `strict` is used for history comparison across weeks: a company often has
// several milestones of one type (e.g. "picks IPO bankers" then "files DRHP"),
// so only near-identical headlines or a matching amount count as the same
// event. Weaker matches are left to the caller to flag for human review.
export function compareEvents(a: EventFeatures, b: EventFeatures, maxDaysApart = 5, strict = false): EventMatch {
  const headlineSim = jaccard(a.headlineTokens, b.headlineTokens);
  // The overlap coefficient flatters very short texts (3 tokens can "overlap"
  // with anything), so fall back to Jaccard unless both leads are substantial.
  const leadSim = Math.min(a.leadTokens.size, b.leadTokens.size) >= 8 ? overlap(a.leadTokens, b.leadTokens) : jaccard(a.leadTokens, b.leadTokens);
  const entity = sharedEntityOf(a, b);
  const sameType = a.eventType === b.eventType && a.eventType !== "other";
  const sharedAmount = a.amounts.some((x) => b.amounts.includes(x));
  const conflictingAmounts =
    a.amounts.length > 0 && b.amounts.length > 0 && !sharedAmount;
  const closeInTime =
    a.publishedAt == null || b.publishedAt == null || Math.abs(a.publishedAt - b.publishedAt) <= maxDaysApart * DAY;

  if (headlineSim >= 0.55 && closeInTime) {
    return { same: true, sharedEntity: entity, reason: "Near-identical headlines", score: headlineSim };
  }
  if (entity && sameType && closeInTime && !conflictingAmounts) {
    const enough = strict ? sharedAmount || headlineSim >= 0.4 : sharedAmount || leadSim >= 0.3 || headlineSim >= 0.25;
    if (enough) {
      return {
        same: true,
        sharedEntity: entity,
        reason: sharedAmount ? `Same ${a.eventType} for ${entity} with matching amount` : `Same ${a.eventType} for ${entity}`,
        score: Math.max(headlineSim, leadSim),
      };
    }
  }
  if (!entity && leadSim >= (strict ? 0.75 : 0.6) && headlineSim >= 0.3 && closeInTime) {
    return { same: true, sharedEntity: null, reason: "Heavily overlapping text", score: leadSim };
  }
  return {
    same: false,
    sharedEntity: entity,
    reason: entity
      ? `Both mention ${entity}, but the developments differ (${a.eventType} vs ${b.eventType})`
      : "Different events",
    score: Math.max(headlineSim, leadSim),
  };
}

export interface ClusterInput {
  id: string;
  headline: string;
  description?: string | null;
  publishedAt?: string | null;
  evidenceRank?: number; // higher = better evidence (used to pick the primary)
}

export interface Cluster {
  id: string;
  primaryId: string;
  memberIds: string[];
  reason: string;
}

// Star clustering: articles are visited from strongest evidence to weakest and
// join a cluster only if they match that cluster's representative directly.
// (Union-find over all pairs chains unrelated stories together: A≈B, B≈C, …)
export function clusterEvents(items: ClusterInput[]): Cluster[] {
  const order = items
    .map((item, i) => ({ item, i, f: eventFeatures(item) }))
    .sort((x, y) => (y.item.evidenceRank ?? 0) - (x.item.evidenceRank ?? 0) || x.i - y.i);
  const clusters: Array<{ primary: (typeof order)[number]; members: string[]; reason: string }> = [];
  for (const entry of order) {
    let joined = false;
    for (const c of clusters) {
      const m = compareEvents(c.primary.f, entry.f);
      if (m.same) {
        c.members.push(entry.item.id);
        if (c.members.length === 2) c.reason = m.reason;
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ primary: entry, members: [entry.item.id], reason: "Single source" });
  }
  return clusters.map((c) => ({ id: `evt_${c.primary.item.id}`, primaryId: c.primary.item.id, memberIds: c.members, reason: c.reason }));
}
