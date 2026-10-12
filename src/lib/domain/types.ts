import type { TopicId } from "./topics";

export type Mode = "preview" | "live";

export type ExtractionStatus =
  | "FEED_ONLY" // only feed/API text available
  | "EXTRACTED" // full page text retrieved
  | "PARTIAL" // page fetched but little usable text
  | "FAILED" // retrieval failed
  | "BLOCKED" // paywall / login / disallowed
  | "SKIPPED"; // not attempted (budget, not needed, or not configured)

export type Provenance = "rss" | "news_api" | "manual" | "sample" | "import";

export interface Article {
  id: string;
  sourceId: string | null;
  publisher: string;
  url: string;
  normalizedUrl: string;
  headline: string;
  author: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  description: string | null;
  extractedText: string | null;
  fingerprint: string | null;
  extractionStatus: ExtractionStatus;
  provenance: Provenance;
  topic: TopicId | null;
  topicOrigin: "ai" | "rules" | "editor" | "sample" | null;
  clusterId: string | null;
  evidenceNotes: string[];
}

export interface RubricScores {
  relevance: number;
  consequence: number;
  novelty: number;
  evidence: number;
  underReported: number;
  counterintuitive: number;
  connection: number;
  noise: number; // promotional / repetitive — higher is worse
}

export type ContentOrigin = "ai" | "editor" | "sample" | "rules" | "empty";

export interface SourceRef {
  publisher: string;
  url: string;
  headline?: string;
}

export interface EditionStory {
  id: string;
  articleId: string;
  position: number;
  headline: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
  topic: TopicId;
  commentary: string;
  commentaryOrigin: ContentOrigin;
  rationale: string;
  rationaleOrigin: ContentOrigin;
  scores: RubricScores | null;
  warnings: string[];
  corroborating: SourceRef[];
  reviewStatus: "PENDING" | "APPROVED";
  version: number;
  styleGuideVersion: number | null;
  clusterId: string | null;
  historyNote: string | null;
}

export type EditionStatus =
  | "COLLECTING"
  | "DRAFTING"
  | "IN_REVIEW"
  | "SCHEDULED" // approved against a specific revision, waiting for send time
  | "SENDING"
  | "SENT"
  | "PARTIALLY_SENT"
  | "FAILED"
  | "CANCELLED";

export const FROZEN_STATUSES: EditionStatus[] = ["SENDING", "SENT", "PARTIALLY_SENT", "FAILED", "CANCELLED"];

export interface Approval {
  id: string;
  revision: number;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
  channel: "dashboard" | "telegram";
  sendAt: string;
  sendNow: boolean;
  recipientCount: number;
  sender: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface Edition {
  id: string;
  publishDate: string; // YYYY-MM-DD in workspace timezone
  issueNumber: number | null;
  subject: string;
  intro: string;
  status: EditionStatus;
  revision: number;
  stories: EditionStory[];
  approval: Approval | null;
  generatedBy: "ai" | "manual" | "sample" | null;
  draftNotes: string[];
  lockVersion: number;
  updatedAt: string;
}

export interface EditionSnapshot {
  editionId: string;
  publishDate: string;
  issueNumber: number | null;
  revision: number;
  contentHash: string;
  subject: string;
  intro: string;
  stories: Array<Pick<EditionStory, "articleId" | "headline" | "publisher" | "url" | "publishedAt" | "topic" | "commentary">>;
}

export interface DomainError {
  code: "CONFLICT" | "FROZEN" | "NOT_FOUND" | "INVALID" | "STALE" | "BLOCKED";
  message: string;
  current?: unknown;
}

export interface DomainEvent {
  action: string;
  message: string;
  details?: Record<string, unknown>;
}

export type CommandResult =
  | { ok: true; edition: Edition; events: DomainEvent[] }
  | { ok: false; error: DomainError };

export interface Candidate {
  articleId: string;
  headline: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
  topic: TopicId;
  clusterId: string | null;
  rationale: string;
  rationaleOrigin: ContentOrigin;
  score: number | null;
  scores: RubricScores | null;
  commentary?: string;
  commentaryOrigin?: ContentOrigin;
  warnings: string[];
  corroborating: SourceRef[];
  historyNote: string | null;
}

export type DeliveryStatus =
  | "PENDING"
  | "SENDING"
  | "ACCEPTED"
  | "FAILED_TEMPORARY"
  | "FAILED_PERMANENT"
  | "UNKNOWN"
  | "SKIPPED_UNSUBSCRIBED";

export type SubscriberStatus = "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED";
