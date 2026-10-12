// Topic taxonomy. Topics are assigned from article content (by Gemini when
// available, otherwise by the keyword rules below, otherwise by the editor).
// They exist so the edition can be checked for genuine breadth — never
// relabel a story just to hit the three-topic minimum.

export const TOPICS = {
  funding: "Funding & capital",
  exits: "Exits, IPOs & M&A",
  policy: "Policy & regulation",
  fintech: "Fintech",
  commerce: "Commerce & consumer",
  enterprise: "Enterprise & SaaS",
  ai_deeptech: "AI & deep tech",
  climate_mobility: "Climate & mobility",
  health_edu: "Health & education",
  governance: "Governance & workforce",
  other: "Other",
} as const;

export type TopicId = keyof typeof TOPICS;
export const TOPIC_IDS = Object.keys(TOPICS) as TopicId[];

export function topicLabel(id: string | null | undefined): string {
  if (!id) return "Unassigned";
  return (TOPICS as Record<string, string>)[id] ?? "Unassigned";
}

export function isTopicId(value: unknown): value is TopicId {
  return typeof value === "string" && value in TOPICS;
}

// "other" is allowed as a label but does not count toward topic diversity,
// otherwise a bucket of unrelated stories could satisfy the rule.
export function countsTowardDiversity(id: TopicId | null | undefined): boolean {
  return !!id && id !== "other";
}

export function distinctTopics(ids: Array<TopicId | null | undefined>): TopicId[] {
  return [...new Set(ids.filter(countsTowardDiversity) as TopicId[])];
}

// Deterministic fallback classifier. Ordered: the first rule with a hit wins,
// and more specific events (IPO, acquisition) beat generic funding language.
const RULES: Array<[TopicId, RegExp]> = [
  ["exits", /\b(ipo|drhp|listing|lists on|acquir\w*|acquisition|merger|buyout|exit)\b/i],
  ["policy", /\b(rbi|sebi|meity|regulat\w*|policy|ministry|government|govt|tax|gst|compliance|court|ban|guidelines?|law|bill)\b/i],
  ["governance", /\b(layoffs?|laid off|job cuts|resign\w*|ceo exits?|board|audit|fraud|governance|lawsuit|esops?|employees)\b/i],
  ["fintech", /\b(fintech|upi|payments?|lending|nbfc|loan|insurance|insurtech|wealth|neobank|credit|bank)\b/i],
  ["ai_deeptech", /\b(ai|genai|llm|artificial intelligence|semiconductor|chip|deep ?tech|space|robotics|quantum|drone)\b/i],
  ["climate_mobility", /\b(ev|electric vehicle|climate|solar|battery|mobility|clean ?tech|carbon|logistics)\b/i],
  ["health_edu", /\b(health\w*|medtech|med-tech|biotech|pharma|vaccines?|clinical|hospitals?|edtech|education|school|learning|diagnostics?)\b/i],
  ["commerce", /\b(d2c|ecommerce|e-commerce|quick commerce|q-?commerce|retail|consumer|brand|marketplace|food delivery|grocery)\b/i],
  ["enterprise", /\b(saas|enterprise|b2b|software|cloud|cybersecurity|devtools?)\b/i],
  ["funding", /\b(raises?|raised|funding|series [a-f]|seed|pre-seed|investment|investors?|valuation|fund|vc|venture)\b/i],
];

export function classifyTopicByRules(text: string): TopicId {
  for (const [topic, re] of RULES) if (re.test(text)) return topic;
  return "other";
}
