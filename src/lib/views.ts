// View models shared by the preview engine (browser) and the live API (server).
// The UI renders only these shapes, so both modes look and behave the same.

import type { ArticleStatus } from "./domain/analysis";
import type { FinalisationReport } from "./domain/edition";
import type { Milestones, ScheduleConfig } from "./domain/schedule";
import type { TopicId } from "./domain/topics";
import type {
  Article,
  Candidate,
  DeliveryStatus,
  Edition,
  Mode,
  SubscriberStatus,
} from "./domain/types";

export type IntegrationKey =
  | "database"
  | "gemini"
  | "rss"
  | "news_api"
  | "scrapingbee"
  | "telegram"
  | "gmail"
  | "resend"
  | "gmail_feedback"
  | "calendar";

export type IntegrationState = "NOT_CONNECTED" | "READY" | "NEEDS_ATTENTION" | "UNAVAILABLE" | "SIMULATED";

export interface IntegrationStatus {
  key: IntegrationKey;
  name: string;
  purpose: string;
  state: IntegrationState;
  detail: string;
  optional: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  missingEnv: string[];
  actions: Array<"connect" | "reconnect" | "test" | "register_webhook" | "link_chat" | "disconnect">;
}

export type PrimaryActionKind =
  | "collect"
  | "generate"
  | "start_manual"
  | "review"
  | "confirm"
  | "view_delivery"
  | "none";

export interface StageInfo {
  step: 0 | 1 | 2 | 3;
  steps: Array<{ label: string; state: "done" | "current" | "upcoming" | "blocked" }>;
  headline: string;
  detail: string;
  primary: { kind: PrimaryActionKind; label: string; hint?: string };
}

export interface AttentionItem {
  id: string;
  tone: "info" | "warn" | "error";
  title: string;
  detail: string;
  href?: string;
}

export interface JobView {
  id: string;
  kind: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stage: string | null;
  error: string | null;
  updatedAt: string;
}

export interface CampaignView {
  id: string;
  revision: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  pausedReason: string | null;
  counts: Partial<Record<DeliveryStatus, number>>;
  total: number;
  simulated: boolean;
}

export interface NotificationView {
  id: string;
  kind: "DRAFT_DELIVERY" | "REMINDER" | "CONFIRMATION";
  channel: "TELEGRAM" | "IN_APP" | "EMAIL";
  status: "SENT" | "FAILED" | "SIMULATED" | "SKIPPED";
  detail: string;
  at: string;
}

export interface ActivityView {
  id: string;
  at: string;
  actor: string;
  action: string;
  message: string;
}

export interface CalendarActionView {
  id: string;
  kind: "REVIEW_BLOCK" | "DEADLINE_ALERT" | "MEETING";
  status: "DRAFT" | "CREATING" | "CREATED" | "FAILED" | "UNKNOWN" | "SIMULATED";
  storyId: string | null;
  title: string;
  startAt: string;
  durationMinutes: number;
  timezone: string;
  attendees: string[];
  agenda: string;
  withMeet: boolean;
  reminderMinutes: number;
  eventUrl: string | null;
  meetUrl: string | null;
  error: string | null;
  confirmedAt: string | null;
}

export interface WeekView {
  mode: Mode;
  now: string;
  timezone: string;
  edition: Edition | null;
  contentHash: string | null;
  finalisation: FinalisationReport | null;
  milestones: Milestones;
  stage: StageInfo;
  attention: AttentionItem[];
  collection: {
    total: number;
    eligible: number;
    duplicates: number;
    sameEvent: number;
    covered: number;
    flagged: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    sourcesOk: number;
    sourcesFailed: number;
    isSample: boolean;
  };
  history: { checked: number; depth: number; label: string };
  recipients: { eligible: number; sender: string | null; dailyLimit: number | null; accountLabel: string };
  capabilities: {
    ai: boolean;
    aiReason: string | null;
    telegram: boolean;
    email: boolean;
    calendar: boolean;
    calendarAvailability: boolean;
  };
  campaign: CampaignView | null;
  notifications: NotificationView[];
  activity: ActivityView[];
  calendarActions: CalendarActionView[];
  job: JobView | null;
  defaultSendAt: string;
  sendTimePassed: boolean;
  styleGuideVersion: number;
}

export interface ArticleRow {
  id: string;
  headline: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
  fetchedAt: string | null;
  topic: TopicId;
  provenance: Article["provenance"];
  extractionStatus: Article["extractionStatus"];
  evidenceNotes: string[];
  status: ArticleStatus;
  reason: string | null;
  clusterId: string | null;
  clusterSize: number;
  draftPosition: number | null;
  historyFlag: string | null;
  description: string | null;
}

export interface SourceRow {
  id: string;
  kind: "rss" | "news_query";
  name: string;
  locator: string;
  enabled: boolean;
  verifiedNote: string | null;
  lastRunAt: string | null;
  lastStatus: "OK" | "FAILED" | "EMPTY" | "SKIPPED" | null;
  lastError: string | null;
  lastItemCount: number | null;
}

export interface RunRow {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  summary: string;
}

export interface ArticlesView {
  mode: Mode;
  timezone: string;
  publishDate: string;
  windowStart: string;
  rows: ArticleRow[];
  sources: SourceRow[];
  runs: RunRow[];
  counts: { total: number; eligible: number; duplicates: number; sameEvent: number; covered: number; outOfWindow: number };
  canAddToDraft: boolean;
  draftSize: number;
  isSample: boolean;
  newsApiNote: string | null;
}

export interface ArchiveEdition {
  id: string;
  publishDate: string;
  issueNumber: number | null;
  subject: string;
  status: string;
  origin: "sent" | "import" | "sample";
  publishedAt: string | null;
  stories: Array<{ headline: string; publisher: string; url: string }>;
  delivery: { accepted: number; failed: number; unknown: number; total: number } | null;
  inMemoryWindow: boolean;
}

export interface ArchiveView {
  mode: Mode;
  timezone: string;
  editions: ArchiveEdition[];
  history: { checked: number; depth: number; label: string };
}

export interface SubscriberRow {
  id: string;
  email: string;
  name: string | null;
  status: SubscriberStatus;
  reason: string | null;
  updatedAt: string;
}

export interface FeedbackRow {
  id: string;
  at: string;
  kind: string;
  recipient: string | null;
  detail: string;
}

export interface AudienceView {
  mode: Mode;
  counts: Record<SubscriberStatus, number> & { total: number };
  subscribers: SubscriberRow[];
  truncated: boolean;
  feedback: FeedbackRow[];
  feedbackEnabled: boolean;
  sending: { account: string | null; dailyLimit: number | null; accountLabel: string };
  lastCampaign: CampaignView | null;
}

export interface SettingsView {
  mode: Mode;
  integrations: IntegrationStatus[];
  styleGuide: { version: number; content: string; examples: string; isStarter: boolean; updatedAt: string };
  schedule: ScheduleConfig;
  sending: { fromName: string; replyTo: string; dailyLimit: number; accountType: "gmail" | "workspace" | "resend" | "custom" };
  newsletter: { name: string; footer: string };
  telegram: { linked: boolean; linkCode: string | null; botUsername: string | null };
  cron: { externalSchedulerUrl: string | null; note: string };
  demoControls: boolean;
}

export interface AlternativesView {
  storyId: string;
  alternatives: Array<{ candidate: Candidate; impact: string; sameTopic: boolean }>;
}

export interface EmailPreviewView {
  subject: string;
  html: string;
  text: string;
  revision: number;
  contentHash: string;
  sender: string | null;
  recipients: number;
  defaultSendAt: string;
  sendTimePassed: boolean;
  timezone: string;
  report: FinalisationReport;
}
