// SAMPLE DATA FOR PREVIEW MODE ONLY.
// Every company, publisher and event below is fictional. URLs point at the
// reserved example.com domain. Dates are placed inside the current week's
// collection window so the workflow can be demonstrated, and the UI labels
// them as sample content — never as articles fetched today.

import type { TopicId } from "../domain/topics";

export interface SampleArticle {
  key: string;
  publisher: string;
  headline: string;
  description: string;
  topic: TopicId;
  hoursAfterWindowStart: number;
  provenance: "rss" | "news_api";
  urlSuffix?: string; // to create exact-duplicate URL variants
  urlKey?: string;
  extracted?: boolean;
}

export const SAMPLE_PUBLISHERS = [
  "Ledger India (sample)",
  "Founders Daily (sample)",
  "The Policy Desk (sample)",
  "Metro Business (sample)",
  "Signal Tech (sample)",
];

const [LEDGER, FOUNDERS, POLICY, METRO, SIGNAL] = SAMPLE_PUBLISHERS;

export const SAMPLE_ARTICLES: SampleArticle[] = [
  // --- One funding round, three publishers (event cluster) + one exact duplicate URL
  { key: "kirana-1", publisher: LEDGER, topic: "funding", hoursAfterWindowStart: 100, provenance: "rss", extracted: true,
    headline: "Kirana Cloud raises $18 million Series B to digitise wholesale credit for small retailers",
    description: "Kirana Cloud, which supplies inventory software to neighbourhood stores, raised $18 million in a Series B round led by Northbridge Capital, the company said. It plans to use the money to expand its credit product, which lets retailers buy stock from distributors on 30-day terms. Credit now accounts for most of its revenue, according to the company." },
  { key: "kirana-1-dup", urlKey: "kirana-1", urlSuffix: "?utm_source=newsapi&utm_medium=referral", publisher: LEDGER, topic: "funding", hoursAfterWindowStart: 100, provenance: "news_api",
    headline: "Kirana Cloud raises $18 million Series B to digitise wholesale credit for small retailers",
    description: "Kirana Cloud raised $18 million in a Series B round led by Northbridge Capital." },
  { key: "kirana-2", publisher: FOUNDERS, topic: "funding", hoursAfterWindowStart: 103, provenance: "rss",
    headline: "Kirana Cloud bags $18 mn in Series B round led by Northbridge",
    description: "B2B retail platform Kirana Cloud has secured $18 mn from Northbridge Capital and existing investors." },
  { key: "kirana-3", publisher: METRO, topic: "funding", hoursAfterWindowStart: 110, provenance: "news_api",
    headline: "Kirana Cloud secures $18 million as investors bet on retail credit",
    description: "Kirana Cloud's $18 million round is the largest this quarter for software aimed at neighbourhood stores." },

  // --- Counterintuitive funding trend
  { key: "tier2-seed", publisher: SIGNAL, topic: "funding", hoursAfterWindowStart: 96, provenance: "rss", extracted: true,
    headline: "Seed rounds in tier-2 cities outnumber Bengaluru's for the first time this quarter",
    description: "Startups headquartered outside the six largest metros closed more seed rounds than Bengaluru-based startups this quarter, according to a tracker compiled by the publication. The median round size outside the metros remained smaller. Investors interviewed attributed the shift to lower burn rates and angel networks in cities such as Indore, Jaipur and Coimbatore." },

  // --- Policy: RBI draft norms (two publishers, same event)
  { key: "rbi-1", publisher: POLICY, topic: "policy", hoursAfterWindowStart: 30, provenance: "rss", extracted: true,
    headline: "RBI draft norms cap default guarantees in digital lending partnerships",
    description: "The Reserve Bank of India released draft norms that would cap first-loss default guarantees offered by lending apps to their bank and NBFC partners. Comments are open for 30 days. Lending startups that rely on such guarantees to originate loans would need to hold more capital or change their partnership structures, according to the draft." },
  { key: "rbi-2", publisher: LEDGER, topic: "policy", hoursAfterWindowStart: 34, provenance: "news_api",
    headline: "RBI draft norms on digital lending put pressure on default guarantee arrangements",
    description: "Fintech lenders face tighter rules on default guarantees under the RBI's new draft norms." },

  // --- Fintech: same company as a previously covered funding story (new development)
  { key: "paysetu-profit", publisher: FOUNDERS, topic: "fintech", hoursAfterWindowStart: 52, provenance: "rss", extracted: true,
    headline: "PaySetu turns profitable on UPI credit lines while merchant fees stay at zero",
    description: "Payments startup PaySetu reported its first profitable quarter, the company said in a statement. The profit came from interest on small credit lines offered over UPI rather than from payment processing, which still earns nothing on most merchant transactions because of zero merchant discount rates." },
  { key: "paysetu-layoffs", publisher: METRO, topic: "governance", hoursAfterWindowStart: 120, provenance: "news_api",
    headline: "PaySetu lays off 120 employees in collections unit",
    description: "PaySetu has let go of about 120 employees in its collections team, two people familiar with the matter said. The company said it was automating parts of the process." },

  // --- Commerce: under-reported pricing shift
  { key: "qcomm-fees", publisher: METRO, topic: "commerce", hoursAfterWindowStart: 70, provenance: "rss", extracted: true,
    headline: "Quick commerce apps quietly raise delivery fees in smaller cities",
    description: "Several quick commerce apps have raised delivery and handling fees in tier-2 cities over the past month, according to price checks by the publication across eight cities. Fees in the largest metros were largely unchanged. Companies did not respond to requests for comment." },
  { key: "haldi-stores", publisher: FOUNDERS, topic: "commerce", hoursAfterWindowStart: 80, provenance: "rss",
    headline: "D2C brand Haldi & Co shuts offline stores to focus on quick commerce",
    description: "Spice brand Haldi & Co will close its 14 offline stores and sell mainly through quick commerce apps, its founder said, citing higher rent and lower footfall." },

  // --- AI & deep tech
  { key: "bhasha-oss", publisher: SIGNAL, topic: "ai_deeptech", hoursAfterWindowStart: 60, provenance: "rss", extracted: true,
    headline: "Bhasha Labs open-sources speech model for 11 Indian languages",
    description: "Bengaluru-based Bhasha Labs released the weights of its speech recognition model covering 11 Indian languages under an open licence. The company said it would charge for hosted access and enterprise support. It did not publish independent accuracy benchmarks." },
  { key: "gpu-subsidy", publisher: POLICY, topic: "ai_deeptech", hoursAfterWindowStart: 44, provenance: "rss", extracted: true,
    headline: "Government GPU subsidy scheme sees few takers among early-stage startups",
    description: "Only a small share of the subsidised GPU capacity offered under a government compute scheme has been booked by early-stage startups, according to officials. Founders cited paperwork, minimum booking periods and a requirement to use specific cloud providers." },

  // --- Exits (two publishers, same event)
  { key: "shipkart-drhp", publisher: LEDGER, topic: "exits", hoursAfterWindowStart: 20, provenance: "rss", extracted: true,
    headline: "Logistics firm Shipkart files DRHP for ₹3,000 crore IPO",
    description: "Shipkart has filed its draft red herring prospectus with SEBI for an IPO of about ₹3,000 crore, including a fresh issue and an offer for sale by early investors. The filing shows the company narrowed its losses last year, according to the document." },
  { key: "shipkart-drhp-2", publisher: METRO, topic: "exits", hoursAfterWindowStart: 26, provenance: "news_api",
    headline: "Shipkart files for ₹3,000 crore IPO, early investors to sell part of stakes",
    description: "Logistics unicorn Shipkart has filed IPO papers with SEBI." },

  // --- Governance
  { key: "fintrack-founder", publisher: FOUNDERS, topic: "governance", hoursAfterWindowStart: 90, provenance: "rss", extracted: true,
    headline: "Fintrack founder steps down after audit flags related-party transactions",
    description: "The co-founder and chief executive of expense software startup Fintrack has stepped down after an external audit flagged transactions with firms linked to company insiders, the board said in a letter to employees. An interim CEO has been appointed." },

  // --- Climate & mobility (one previously covered, one new)
  { key: "volt-prices", publisher: METRO, topic: "climate_mobility", hoursAfterWindowStart: 15, provenance: "rss",
    headline: "EV maker Volt Rides slashes scooter prices by 12% after subsidy lapse",
    description: "Volt Rides cut scooter prices by 12% following the end of a state subsidy." },
  { key: "mitti-labs", publisher: SIGNAL, topic: "climate_mobility", hoursAfterWindowStart: 75, provenance: "rss", extracted: true,
    headline: "Soil-data startup Mitti Labs raises ₹40 crore from climate fund",
    description: "Mitti Labs, which sells soil carbon measurements to agribusinesses, raised ₹40 crore from a climate-focused fund. The company said demand comes mainly from exporters preparing for European reporting requirements." },

  // --- Enterprise
  { key: "ledgerly-contract", publisher: LEDGER, topic: "enterprise", hoursAfterWindowStart: 85, provenance: "rss", extracted: true,
    headline: "Pune SaaS firm Ledgerly signs first US enterprise contract",
    description: "Accounting software startup Ledgerly signed a multi-year contract with a US healthcare group, its first enterprise customer outside India, the company said. It did not disclose the contract value." },
  { key: "ledgerly-cfo", publisher: FOUNDERS, topic: "enterprise", hoursAfterWindowStart: 115, provenance: "news_api",
    headline: "Ledgerly appoints new CFO ahead of US expansion",
    description: "Ledgerly has appointed a chief financial officer with prior experience at a listed IT services company." },

  // --- Policy
  { key: "data-rules", publisher: POLICY, topic: "policy", hoursAfterWindowStart: 65, provenance: "rss", extracted: true,
    headline: "Data protection rules give startups 18 months to comply",
    description: "The government notified the timeline for data protection rules, giving companies 18 months to comply with most obligations. Consent managers and breach reporting requirements take effect earlier, according to the notification." },

  // --- Health & education
  { key: "medisetu", publisher: SIGNAL, topic: "health_edu", hoursAfterWindowStart: 55, provenance: "news_api",
    headline: "Medisetu raises $6 million for rural diagnostics network",
    description: "Diagnostics startup Medisetu raised $6 million to expand sample-collection centres in villages across three states." },
  { key: "padhai-pivot", publisher: FOUNDERS, topic: "health_edu", hoursAfterWindowStart: 40, provenance: "rss", extracted: true,
    headline: "Edtech Padhai pivots from test prep to nursing skills training",
    description: "Edtech startup Padhai is winding down its test preparation courses to focus on vocational training for nurses, including placements abroad. The company said its test-prep revenue had fallen for six consecutive quarters." },

  // --- Fintech / insurance
  { key: "suraksha", publisher: POLICY, topic: "fintech", hoursAfterWindowStart: 95, provenance: "rss",
    headline: "Insurtech Suraksha gets regulatory sandbox approval for usage-based bike insurance",
    description: "Suraksha can test pay-per-kilometre two-wheeler insurance with up to 10,000 customers under the regulator's sandbox." },

  // --- Funding / workforce trend
  { key: "women-founders", publisher: METRO, topic: "funding", hoursAfterWindowStart: 105, provenance: "news_api",
    headline: "Share of funding going to women-led startups falls to a three-year low",
    description: "Startups with at least one woman founder received a smaller share of venture funding this quarter than in any quarter in three years, according to a data provider." },

  // --- Noise
  { key: "awards", publisher: METRO, topic: "other", hoursAfterWindowStart: 50, provenance: "news_api",
    headline: "Startup awards night celebrates 50 founders",
    description: "Sponsored: an awards evening in Mumbai celebrated 50 founders across categories." },

  // --- Older than the window
  { key: "old-story", publisher: LEDGER, topic: "funding", hoursAfterWindowStart: -60, provenance: "rss",
    headline: "Quarterly funding roundup: late-stage deals slow",
    description: "Late-stage funding slowed for a third straight quarter." },
];

// Prewritten editorial picks and commentary for the preview. Labelled in the
// UI as "Sample commentary (prewritten)" — never as AI output.
export const SAMPLE_PICKS: Array<{ key: string; rationale: string; commentary: string }> = [
  { key: "tier2-seed",
    rationale: "Counterintuitive shift in where early capital goes; under-reported beyond the original tracker.",
    commentary: "Seed rounds outside the six largest metros outnumbered Bengaluru's this quarter, according to the publication's tracker. Round sizes are still smaller, so this is a story about cheaper experiments rather than a capital shift. Worth watching whether angel networks in these cities can carry companies to Series A." },
  { key: "rbi-1",
    rationale: "Consequential regulatory change that alters lending-startup economics; two outlets covered it.",
    commentary: "The RBI's draft norms would cap the default guarantees lending apps give their bank and NBFC partners. That guarantee has quietly been the growth engine for many fintech lenders, so the real question is who now holds the risk. Comments are open for 30 days." },
  { key: "paysetu-profit",
    rationale: "A payments company profitable from credit, not payments — a useful signal about UPI economics.",
    commentary: "PaySetu says it reached its first profitable quarter, but the money came from interest on small UPI credit lines, not payments. With merchant fees still at zero, this is another sign that payments is becoming the distribution layer for lending." },
  { key: "qcomm-fees",
    rationale: "Under-reported pricing move with consequences for unit economics outside the metros.",
    commentary: "Price checks across eight cities found quick commerce apps raising delivery and handling fees in tier-2 cities, while metro fees held steady. If smaller cities are where these apps now test pricing power, the subsidy phase may be ending there first." },
  { key: "bhasha-oss",
    rationale: "Open model release with a clear business-model question; connects to the compute-subsidy story.",
    commentary: "Bhasha Labs has released its speech model for 11 Indian languages under an open licence and plans to charge for hosting and support. The company has not published independent benchmarks, so claims about accuracy should wait." },
  { key: "gpu-subsidy",
    rationale: "Counterintuitive: subsidised compute is going unused. Pairs with the Bhasha Labs release.",
    commentary: "Early-stage startups have booked only a small share of the government's subsidised GPU capacity, officials say. Founders point to paperwork, minimum booking periods and mandated cloud providers. A subsidy that is hard to use mostly helps those who need it least." },
  { key: "shipkart-drhp",
    rationale: "Major exit event; the filing contains real numbers rather than projections.",
    commentary: "Shipkart has filed for an IPO of about ₹3,000 crore, part of it an offer for sale by early investors. The prospectus says losses narrowed last year; the full filing is a rare look at logistics unit economics." },
  { key: "fintrack-founder",
    rationale: "Governance failure with implications for how boards oversee founder-led startups.",
    commentary: "Fintrack's founder has stepped down after an external audit flagged transactions with firms linked to insiders, the board told employees. It is another case where a governance problem surfaced through an audit rather than through the board." },
  { key: "kirana-1",
    rationale: "Largest round in its category; three outlets covered it, consolidated into one slot.",
    commentary: "Kirana Cloud raised $18 million led by Northbridge Capital and says credit, not software, now drives most of its revenue. The pattern matches PaySetu: the software gets the customer, and lending pays the bills." },
];

export const SAMPLE_ALT_COMMENTARY: Record<string, string> = {
  "mitti-labs": "Mitti Labs raised ₹40 crore to sell soil carbon measurements to agribusinesses. Demand is coming from exporters preparing for European reporting rules, which makes this a compliance business as much as a climate one.",
  "ledgerly-contract": "Ledgerly has signed its first enterprise customer outside India, a US healthcare group, without disclosing the value. One contract is not a trend, but Pune-built accounting software selling into US healthcare is worth noting.",
  "data-rules": "The government has given companies 18 months to comply with most data protection obligations, with consent and breach rules arriving sooner. Early-stage startups now have a deadline to plan for.",
  "medisetu": "Medisetu raised $6 million to expand rural sample-collection centres across three states. The hard part in rural diagnostics is logistics, not testing.",
  "padhai-pivot": "Padhai is dropping test prep for nursing skills training after six quarters of falling test-prep revenue. Edtech's most durable demand may be for jobs, not exams.",
  "suraksha": "Suraksha can now test pay-per-kilometre bike insurance with up to 10,000 customers under the regulator's sandbox. Usage-based pricing has struggled in India; a sandbox gives it a controlled trial.",
  "women-founders": "The share of funding going to startups with a woman founder fell to its lowest level in three years, according to a data provider. In a cautious market, capital is concentrating in familiar networks.",
  "haldi-stores": "Haldi & Co is closing all 14 of its stores to sell through quick commerce apps, citing rent and footfall. It is a bet that the apps' shelf is cheaper than its own.",
  "paysetu-layoffs": "PaySetu has let go of about 120 people in collections, according to two people familiar with the matter. Alongside its first profitable quarter, it suggests the credit business is being run for margin.",
};

// Three previously published sample editions — deliberately fewer than four,
// so the preview demonstrates the partial-history state honestly.
export const SAMPLE_HISTORY: Array<{ weeksAgo: number; issue: number; subject: string; stories: Array<{ headline: string; publisher: string; slug: string }> }> = [
  { weeksAgo: 1, issue: 103, subject: "Subsidies end, prices follow", stories: [
    { headline: "Volt Rides cuts scooter prices 12% as EV subsidy ends", publisher: METRO, slug: "volt-prices-cut" },
    { headline: "Cloud kitchen operator closes 40 outlets in Delhi", publisher: FOUNDERS, slug: "cloud-kitchen-closures" },
    { headline: "SEBI eases rules for angel funds", publisher: POLICY, slug: "sebi-angel-funds" },
  ] },
  { weeksAgo: 2, issue: 102, subject: "Credit is the business model", stories: [
    { headline: "PaySetu raises $30 million to expand UPI credit", publisher: LEDGER, slug: "paysetu-30m" },
    { headline: "Agritech marketplace pivots to input financing", publisher: SIGNAL, slug: "agritech-pivot" },
  ] },
  { weeksAgo: 3, issue: 101, subject: "The quiet IPO queue", stories: [
    { headline: "Shipkart picks bankers for IPO", publisher: LEDGER, slug: "shipkart-bankers" },
    { headline: "Edtech layoffs continue as test-prep demand falls", publisher: METRO, slug: "edtech-layoffs" },
  ] },
];

export const SAMPLE_SUBSCRIBERS = [
  { email: "reader.one@example.com", name: "Sample Reader 1", status: "ACTIVE" as const },
  { email: "reader.two@example.com", name: "Sample Reader 2", status: "ACTIVE" as const },
  { email: "reader.three@example.com", name: "Sample Reader 3", status: "ACTIVE" as const },
  { email: "reader.four@example.com", name: "Sample Reader 4", status: "ACTIVE" as const },
  { email: "reader.five@example.com", name: "Sample Reader 5", status: "ACTIVE" as const },
  { email: "left.last.week@example.com", name: "Sample Reader 6", status: "UNSUBSCRIBED" as const },
  { email: "no-such-mailbox@example.com", name: "Sample Reader 7", status: "BOUNCED" as const },
];

export const SAMPLE_SOURCES = [
  { name: "Ledger India (sample feed)", kind: "rss" as const },
  { name: "Founders Daily (sample feed)", kind: "rss" as const },
  { name: "The Policy Desk (sample feed)", kind: "rss" as const },
  { name: "Signal Tech (sample feed)", kind: "rss" as const },
  { name: "Metro Business (sample feed)", kind: "rss" as const },
  { name: "News query: “India startup funding” (sample)", kind: "news_query" as const },
];
