// Answers the dashboard's three questions: what stage is this edition at,
// what needs attention, and what is the single next action.

import type { FinalisationReport } from "./edition";
import { formatInZone } from "./schedule";
import type { Edition } from "./types";
import type { CampaignView, StageInfo } from "../views";

const LABELS = ["Collect", "Review", "Approve", "Deliver"] as const;

function steps(current: number, blockedAt: number | null = null, allDone = false): StageInfo["steps"] {
  return LABELS.map((label, i) => ({
    label,
    state: allDone || i < current ? "done" : i === current ? (blockedAt === i ? "blocked" : "current") : "upcoming",
  }));
}

export function computeStage(input: {
  edition: Edition | null;
  articleCount: number;
  eligibleCount: number;
  report: FinalisationReport | null;
  aiAvailable: boolean;
  campaign: CampaignView | null;
  timezone: string;
  draftAt: string;
  jobRunning: string | null;
}): StageInfo {
  const { edition: ed, timezone: tz } = input;

  if (input.jobRunning === "COLLECT") {
    return { step: 0, steps: steps(0), headline: "Collecting articles", detail: "Fetching your sources now.", primary: { kind: "none", label: "Collecting…" } };
  }
  if (ed?.status === "DRAFTING" || input.jobRunning === "GENERATE_DRAFT") {
    return { step: 1, steps: steps(1), headline: "Generating the draft", detail: "Gemini is evaluating candidates and writing commentary.", primary: { kind: "none", label: "Generating…" } };
  }

  if (!ed || (ed.status === "COLLECTING" && ed.stories.length === 0)) {
    if (input.articleCount === 0) {
      return {
        step: 0,
        steps: steps(0),
        headline: "No articles collected yet",
        detail: "Collection runs Monday to Wednesday. You can run it now.",
        primary: { kind: "collect", label: "Collect articles" },
      };
    }
    return {
      step: 0,
      steps: steps(0),
      headline: `${input.eligibleCount} eligible stories from ${input.articleCount} articles`,
      detail: input.aiAvailable
        ? `The draft is generated automatically on ${formatInZone(input.draftAt, tz)}. You can generate it now.`
        : "Gemini isn't connected, so build the draft yourself from the Articles list.",
      primary: input.aiAvailable
        ? { kind: "generate", label: "Generate draft" }
        : { kind: "start_manual", label: "Pick stories", hint: "Opens the article list" },
    };
  }

  if (ed.status === "IN_REVIEW" || ed.status === "COLLECTING") {
    const contentBlockers = input.report?.blockers.filter((b) => !/subscriber|sending|Gmail|daily limit|connected/i.test(b)) ?? [];
    const pending = ed.stories.filter((s) => s.reviewStatus !== "APPROVED").length;
    const revoked = ed.approval?.revokedAt ? " Your earlier approval was withdrawn because the content changed." : "";
    if (contentBlockers.length) {
      return {
        step: 1,
        steps: steps(1),
        headline: "Draft needs attention",
        detail: `${contentBlockers[0]}${revoked}`,
        primary: { kind: "review", label: "Review draft" },
      };
    }
    return {
      step: 2,
      steps: steps(2),
      headline: pending ? `Draft ready · ${pending} of ${ed.stories.length} stories not yet reviewed` : "All stories reviewed",
      detail: `Confirming approves the whole edition as it stands now and schedules it.${revoked}`,
      primary: { kind: "confirm", label: "Confirm and schedule" },
    };
  }

  if (ed.status === "SCHEDULED") {
    return {
      step: 3,
      steps: steps(3),
      headline: `Scheduled for ${formatInZone(ed.approval?.sendAt, tz)}`,
      detail: `Revision ${ed.approval?.revision} approved. Any edit withdraws this approval.`,
      primary: { kind: "view_delivery", label: "View delivery" },
    };
  }
  if (ed.status === "SENDING") {
    return { step: 3, steps: steps(3), headline: "Sending now", detail: "Delivery is in progress in small batches.", primary: { kind: "view_delivery", label: "View delivery" } };
  }
  if (ed.status === "SENT") {
    return { step: 3, steps: steps(3, null, true), headline: input.campaign?.simulated ? "Delivery simulated" : "Edition sent", detail: "Accepted by the email provider. Acceptance is not proof of inbox delivery or opens.", primary: { kind: "view_delivery", label: "View delivery" } };
  }
  if (ed.status === "PARTIALLY_SENT") {
    return { step: 3, steps: steps(3, 3), headline: "Partially sent", detail: "Some recipients could not be reached. Review the delivery report.", primary: { kind: "view_delivery", label: "View delivery" } };
  }
  if (ed.status === "FAILED") {
    return { step: 3, steps: steps(3, 3), headline: "Delivery failed", detail: "No messages were accepted. Review the delivery report.", primary: { kind: "view_delivery", label: "View delivery" } };
  }
  return { step: 0, steps: steps(0), headline: "Edition cancelled", detail: "", primary: { kind: "none", label: "" } };
}
