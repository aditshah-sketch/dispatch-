// The action contract shared by the preview engine and the live API.
// The UI calls `client.run(name, input)` without knowing which mode it is in.

import type { StoryPatch } from "../domain/edition";
import type { ScheduleConfig } from "../domain/schedule";
import type { EditionStory } from "../domain/types";
import type { CalendarActionView } from "../views";

export type ActionResult<T = unknown> =
  | { ok: true; data: T; message?: string; simulated?: boolean }
  | { ok: false; error: { code: string; message: string; current?: unknown } };

export interface CalendarDraftInput {
  id?: string;
  kind: CalendarActionView["kind"];
  storyId?: string | null;
  title: string;
  startAt: string;
  durationMinutes: number;
  attendees: string[];
  agenda: string;
  withMeet: boolean;
  reminderMinutes: number;
}

export interface ActionMap {
  collect: { input: Record<string, never>; output: { jobId?: string } };
  generateDraft: { input: { replace?: boolean }; output: { jobId?: string } };
  editStory: { input: { storyId: string; baseVersion: number; patch: StoryPatch }; output: { story: EditionStory; revision: number } };
  setStoryReview: { input: { storyId: string; approved: boolean }; output: null };
  removeStory: { input: { storyId: string }; output: null };
  swapStory: { input: { storyId: string; articleId: string }; output: null };
  addStory: { input: { articleId: string }; output: null };
  moveStory: { input: { storyId: string; direction: -1 | 1 }; output: null };
  editFraming: { input: { subject?: string; intro?: string; baseRevision: number }; output: { revision: number } };
  regenerateCommentary: { input: { storyId: string; baseVersion: number }; output: { story: EditionStory } };
  confirmEdition: { input: { revision: number; contentHash: string; sendNow: boolean; sendAt: string | null }; output: null };
  revokeApproval: { input: { reason: string }; output: null };
  sendDraftToTelegram: { input: Record<string, never>; output: null };
  retryUnknownDeliveries: { input: { confirm: true }; output: null };
  addSubscribers: { input: { text: string }; output: { added: number; skipped: number; invalid: string[] } };
  setSubscriberStatus: { input: { id: string; status: "UNSUBSCRIBED" | "ACTIVE" }; output: null };
  importHistory: { input: { publishDate: string; subject: string; stories: string }; output: { stories: number } };
  saveStyleGuide: { input: { content: string; examples: string }; output: { version: number } };
  saveSchedule: { input: { schedule: ScheduleConfig }; output: null };
  saveSending: { input: { fromName: string; replyTo: string; dailyLimit: number; accountType: "gmail" | "workspace" | "custom"; newsletterName: string; footer: string }; output: null };
  toggleSource: { input: { id: string; enabled: boolean }; output: null };
  addSource: { input: { kind: "rss" | "news_query"; name: string; locator: string }; output: null };
  testIntegration: { input: { key: string }; output: { detail: string } };
  registerTelegramWebhook: { input: Record<string, never>; output: { detail: string } };
  createTelegramLinkCode: { input: Record<string, never>; output: { code: string } };
  saveCalendarDraft: { input: CalendarDraftInput; output: { id: string } };
  suggestMeeting: { input: { storyId: string }; output: { title: string; agenda: string; origin: "ai" | "template" } };
  checkAvailability: { input: { startAt: string; durationMinutes: number }; output: { checked: boolean; conflicts: Array<{ start: string; end: string }>; note: string } };
  bookCalendarAction: { input: { id: string; confirm: true; detailsHash: string }; output: null };
  deleteCalendarDraft: { input: { id: string }; output: null };
  runScheduledNow: { input: { task: "draft_delivery" | "reminder" | "send_due" | "feedback" | "process_jobs" }; output: { detail: string } };
  resetPreview: { input: Record<string, never>; output: null };
}

export type ActionName = keyof ActionMap;

// Stable hash of the meeting details shown to the user at confirmation time;
// booking is rejected if the stored draft differs from what was confirmed.
export function calendarDetailsKey(a: Pick<CalendarActionView, "title" | "startAt" | "durationMinutes" | "attendees" | "agenda" | "withMeet" | "reminderMinutes" | "timezone">): string {
  return JSON.stringify([a.title, a.startAt, a.durationMinutes, [...a.attendees].sort(), a.agenda, a.withMeet, a.reminderMinutes, a.timezone]);
}
