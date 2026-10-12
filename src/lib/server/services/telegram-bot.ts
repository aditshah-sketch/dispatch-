import "server-only";
import { alternativesFor } from "../../domain/analysis";
import { confirmEdition, contentHash, editStory, finalisationReport, setStoryReview, snapshotOf, swapStory } from "../../domain/edition";
import { renderEmail } from "../../domain/email-render";
import { formatInZone, formatYmd, milestonesFor } from "../../domain/schedule";
import { distinctTopics, topicLabel } from "../../domain/topics";
import type { Edition } from "../../domain/types";
import { config, WORKSPACE_ID } from "../config";
import { randomToken, safeEqual } from "../crypto";
import type { Db } from "../db/client";
import { paginate, TelegramClient, TelegramError, tgEscape as esc, type InlineButton } from "../providers/telegram";
import { audit, markHealth, notify } from "../repo/ops";
import { getSettings } from "../repo/settings";
import { applyCommand, currentEdition, finalisationContext, liveAnalysis } from "./editorial";

// Telegram as a real review channel. Every button carries an opaque token
// (≤ 64 bytes of callback_data) stored server-side and bound to the edition,
// revision and story version it was created for. Stale buttons are rejected.

const ACTION_TTL_HOURS = 24 * 7;

export async function telegramTarget(db: Db): Promise<{ client: TelegramClient; chatId: string } | { error: string }> {
  const t = config.telegram();
  if (!t.ok) return { error: `Telegram isn't configured (${t.missing.join(", ")}).` };
  const settings = await getSettings(db);
  const chatId = t.value!.ownerChatId ?? settings.telegramChatId;
  if (!chatId) return { error: "No Telegram chat is linked yet. Generate a link code in Settings and send it to the bot." };
  return { client: new TelegramClient(t.value!.token), chatId };
}

async function token(db: Db, ed: Edition, action: string, o: { storyId?: string; storyVersion?: number; payload?: Record<string, unknown>; promptMessageId?: number } = {}): Promise<string> {
  const t = randomToken(9); // 12 chars → "t:" + 12 = 14 bytes of callback_data
  await db.query(
    `insert into telegram_actions (token, workspace_id, edition_id, revision, story_id, story_version, action, payload, prompt_message_id, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now() + ($10::int * interval '1 hour'))`,
    [t, WORKSPACE_ID, ed.id, ed.revision, o.storyId ?? null, o.storyVersion ?? null, action, JSON.stringify(o.payload ?? {}), o.promptMessageId != null ? String(o.promptMessageId) : null, ACTION_TTL_HOURS],
  );
  return `t:${t}`;
}

function dashboardButton(): InlineButton[] {
  const base = config.baseUrl();
  return base && base.startsWith("https://") ? [{ text: "Open dashboard", url: `${base}/desk` }] : [];
}

async function send(client: TelegramClient, chatId: string, text: string, buttons?: InlineButton[][]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.sendMessage(chatId, text, { buttons });
    } catch (e) {
      if (e instanceof TelegramError && e.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, Math.min(5, e.retryAfter ?? 1) * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new TelegramError("Telegram rate limit", 429);
}

function storyText(ed: Edition, i: number): string {
  const s = ed.stories[i];
  return [
    `<b>#${s.position} · ${esc(topicLabel(s.topic))}</b>${s.reviewStatus === "APPROVED" ? " ✓" : ""}`,
    `<a href="${esc(s.url)}">${esc(s.headline)}</a>`,
    `<i>${esc(s.publisher)}</i>`,
    "",
    s.commentary ? esc(s.commentary) : "<i>(no commentary yet)</i>",
    "",
    `<i>Why: ${esc(s.rationale || "added by you")}</i>`,
    s.historyNote ? `⚑ ${esc(s.historyNote)}` : null,
    s.warnings.length ? `⚠ ${esc(s.warnings.join("; "))}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export async function sendDraft(db: Db, actor: string): Promise<{ ok: boolean; message: string }> {
  const ed = await currentEdition(db);
  if (!ed.stories.length) return { ok: false, message: "There is no draft to send yet." };
  const target = await telegramTarget(db);
  if ("error" in target) {
    await notify(db, { editionId: ed.id, kind: "DRAFT_DELIVERY", channel: "IN_APP", status: "SKIPPED", revision: ed.revision, detail: `Draft ready for review here. ${target.error}` });
    return { ok: false, message: target.error };
  }
  const settings = await getSettings(db);
  const ctx = await finalisationContext(db);
  const report = finalisationReport(ed, ctx);
  try {
    await send(
      target.client,
      target.chatId,
      [
        `<b>${esc(settings.newsletter.name)} · ${esc(formatYmd(ed.publishDate))}</b>`,
        `Draft revision ${ed.revision} · ${ed.stories.length} stories · ${report.topics.length} topics`,
        `Topics: ${esc(report.topics.map(topicLabel).join(", ") || "—")}`,
        report.blockers.length ? `\n<b>Before confirming:</b>\n${report.blockers.map((b) => `• ${esc(b)}`).join("\n")}` : "",
        `\nReview each story below. Nothing is sent until you confirm the final edition.`,
      ].join("\n"),
      dashboardButton().length ? [dashboardButton()] : undefined,
    );
    for (let i = 0; i < ed.stories.length; i++) {
      const s = ed.stories[i];
      await send(target.client, target.chatId, storyText(ed, i), [[
        { text: "✓ Approve", callback_data: await token(db, ed, "approve", { storyId: s.id, storyVersion: s.version }) },
        { text: "✎ Edit", callback_data: await token(db, ed, "edit", { storyId: s.id, storyVersion: s.version }) },
        { text: "⇄ Swap", callback_data: await token(db, ed, "swap", { storyId: s.id, storyVersion: s.version }) },
      ]]);
      await new Promise((r) => setTimeout(r, 350)); // stay well under ~1 msg/sec/chat
    }
    await send(target.client, target.chatId, "When you're happy with the draft:", [[
      { text: "Preview email", callback_data: await token(db, ed, "preview") },
      { text: "Review & confirm…", callback_data: await token(db, ed, "confirm_start") },
    ]]);
    await notify(db, { editionId: ed.id, kind: "DRAFT_DELIVERY", channel: "TELEGRAM", status: "SENT", revision: ed.revision, detail: `Draft revision ${ed.revision} (${ed.stories.length} stories) delivered to Telegram.` });
    await audit(db, { actor, action: "telegram.draft_sent", entityType: "edition", entityId: ed.id, message: `Draft revision ${ed.revision} sent to Telegram.` });
    await markHealth(db, "telegram", true);
    return { ok: true, message: "Draft sent to Telegram." };
  } catch (e) {
    const msg = (e as Error).message;
    await notify(db, { editionId: ed.id, kind: "DRAFT_DELIVERY", channel: "TELEGRAM", status: "FAILED", revision: ed.revision, detail: `Telegram delivery failed: ${msg}. The draft is safe here; retry from the dashboard.` });
    await markHealth(db, "telegram", false, msg);
    return { ok: false, message: `Telegram delivery failed: ${msg}` };
  }
}

// Wednesday 10 PM: reminds, never sends. Once per edition (job dedupe key).
export async function sendReminder(db: Db): Promise<string> {
  const ed = await currentEdition(db);
  if (["SCHEDULED", "SENDING", "SENT", "PARTIALLY_SENT"].includes(ed.status)) return "Edition already confirmed; no reminder needed.";
  const settings = await getSettings(db);
  const m = milestonesFor(ed.publishDate, settings.schedule);
  const text = `<b>Reminder:</b> the ${esc(formatYmd(ed.publishDate, "short"))} edition hasn't been confirmed yet. It is scheduled for ${esc(formatInZone(m.sendAt, settings.schedule.timezone))}, but <b>nothing will be sent without your confirmation</b>.`;
  await notify(db, { editionId: ed.id, kind: "REMINDER", channel: "IN_APP", status: "SENT", revision: ed.revision, detail: "Final confirmation hasn't arrived. Nothing will be sent until you confirm." });
  const target = await telegramTarget(db);
  if ("error" in target) return `In-app reminder recorded. ${target.error}`;
  try {
    const buttons = ed.stories.length ? [[{ text: "Review & confirm…", callback_data: await token(db, ed, "confirm_start") }]] : undefined;
    await send(target.client, target.chatId, text, buttons);
    await notify(db, { editionId: ed.id, kind: "REMINDER", channel: "TELEGRAM", status: "SENT", revision: ed.revision, detail: "Missing-approval reminder sent to Telegram." });
    return "Reminder sent to Telegram and shown in the dashboard.";
  } catch (e) {
    await notify(db, { editionId: ed.id, kind: "REMINDER", channel: "TELEGRAM", status: "FAILED", revision: ed.revision, detail: `Telegram reminder failed: ${(e as Error).message}` });
    return `In-app reminder recorded; Telegram failed: ${(e as Error).message}`;
  }
}

export async function notifyApprovalRevoked(db: Db, ed: Edition) {
  const target = await telegramTarget(db);
  if ("error" in target) return;
  await send(target.client, target.chatId, `Approval withdrawn for the ${esc(formatYmd(ed.publishDate, "short"))} edition: ${esc(ed.approval?.revokedReason ?? "content changed")}. The scheduled send was cancelled. Confirm again when ready.`, [[
    { text: "Review & confirm…", callback_data: await token(db, ed, "confirm_start") },
  ]]);
}

// ---------- Webhook handling ----------

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number } }; data?: string };
}

export async function handleUpdate(db: Db, update: TgUpdate): Promise<void> {
  const t = config.telegram().value!;
  const client = new TelegramClient(t.token);
  // Deduplicate redelivered updates.
  const fresh = await db.query(`insert into telegram_updates (update_id) values ($1) on conflict do nothing returning update_id`, [String(update.update_id)]);
  if (!fresh.length) return;

  const settings = await getSettings(db);
  const owner = t.ownerChatId ?? settings.telegramChatId;
  const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? "");
  const fromId = String(update.message?.from?.id ?? update.callback_query?.from.id ?? "");

  // Linking: "/start CODE" from Settings, single-use and time-limited.
  const text = update.message?.text?.trim() ?? "";
  if (!owner && text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] ?? "";
    const valid = settings.telegramLinkCode && settings.telegramLinkExpiresAt && Date.parse(settings.telegramLinkExpiresAt) > Date.now() && safeEqual(code, settings.telegramLinkCode);
    if (valid && chatId === fromId) {
      await db.query(`update workspace_settings set telegram_chat_id = $2, telegram_link_code = null, telegram_link_expires_at = null where workspace_id = $1`, [WORKSPACE_ID, chatId]);
      await audit(db, { actor: "telegram", action: "telegram.linked", message: "Telegram chat linked to this newsletter." });
      await client.sendMessage(chatId, "Linked. Drafts, reviews and reminders for The Dispatch will arrive here.");
    } else {
      await client.sendMessage(chatId, "That link code isn't valid or has expired. Generate a new one in Settings.").catch(() => undefined);
    }
    return;
  }

  // Everything else is restricted to the owner's private chat.
  if (!owner || chatId !== owner || fromId !== owner) {
    if (update.callback_query) await client.answerCallback(update.callback_query.id, "Not authorised.").catch(() => undefined);
    await audit(db, { actor: "telegram", action: "telegram.rejected", message: `Ignored update from an unauthorised chat.` });
    return;
  }

  if (update.callback_query) return handleCallback(db, client, owner, update.callback_query);
  if (update.message?.reply_to_message) return handleReplyEdit(db, client, owner, update.message);
  if (text === "/draft") {
    const r = await sendDraft(db, "telegram:owner");
    if (!r.ok) await client.sendMessage(owner, esc(r.message));
    return;
  }
  if (text === "/status" || text === "/start") {
    const ed = await currentEdition(db);
    await client.sendMessage(owner, `Edition ${esc(formatYmd(ed.publishDate, "short"))}: ${esc(ed.status.replace("_", " ").toLowerCase())}, revision ${ed.revision}, ${ed.stories.length} stories.\nCommands: /draft to resend the draft, /status for this summary.`);
  }
}

async function loadAction(db: Db, data: string) {
  if (!data.startsWith("t:")) return null;
  const [r] = await db.query<Record<string, unknown>>(`select * from telegram_actions where token = $1 and workspace_id = $2`, [data.slice(2), WORKSPACE_ID]);
  if (!r) return null;
  return {
    token: String(r.token), editionId: String(r.edition_id), revision: Number(r.revision), storyId: (r.story_id as string) ?? null,
    storyVersion: r.story_version == null ? null : Number(r.story_version), action: String(r.action), payload: (r.payload as Record<string, unknown>) ?? {},
    expired: Date.parse(String(r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at)) < Date.now(), used: !!r.used_at,
  };
}

async function handleCallback(db: Db, client: TelegramClient, chatId: string, cq: NonNullable<TgUpdate["callback_query"]>) {
  const a = await loadAction(db, cq.data ?? "");
  if (!a || a.expired) return void (await client.answerCallback(cq.id, "This button has expired. Send /draft for a fresh copy.", true));
  if (a.used) return void (await client.answerCallback(cq.id, "Already done."));
  const ed = await currentEdition(db);
  if (ed.id !== a.editionId) return void (await client.answerCallback(cq.id, "This button belongs to a previous edition.", true));
  const actor = "telegram:owner";

  switch (a.action) {
    case "approve": {
      const r = await applyCommand(db, actor, (e, at) => setStoryReview(e, { storyId: a.storyId!, expectedVersion: a.storyVersion!, approved: true }, at));
      await client.answerCallback(cq.id, r.ok ? "Approved ✓" : r.error.message, !r.ok);
      return;
    }
    case "edit": {
      const story = ed.stories.find((s) => s.id === a.storyId);
      if (!story || story.version !== a.storyVersion) return void (await client.answerCallback(cq.id, "This story changed since that message. Send /draft for the current version.", true));
      await client.answerCallback(cq.id);
      const prompt = await client.sendMessage(chatId, `Reply to this message with the new commentary for <b>#${story.position}</b>. Current text:\n\n${esc(story.commentary)}`, { forceReply: true, placeholder: `New commentary for #${story.position}` });
      await token(db, ed, "edit_reply", { storyId: story.id, storyVersion: story.version, promptMessageId: prompt.message_id });
      return;
    }
    case "swap": {
      const story = ed.stories.find((s) => s.id === a.storyId);
      if (!story || story.version !== a.storyVersion) return void (await client.answerCallback(cq.id, "This story changed since that message.", true));
      await client.answerCallback(cq.id, "Finding alternatives…");
      const alts = alternativesFor(ed, story.id, (await liveAnalysis(db, ed)).candidates, 3);
      if (!alts.length) return void (await client.sendMessage(chatId, "No eligible alternatives right now — everything else is a duplicate, same event, or previously covered."));
      const lines = alts.map((x, i) => `<b>${i + 1}.</b> ${esc(x.candidate.headline)} <i>(${esc(x.candidate.publisher)}, ${esc(topicLabel(x.candidate.topic))})</i>\n${esc(x.impact)}`);
      const buttons = [];
      for (let i = 0; i < alts.length; i++) {
        buttons.push([{ text: `Use ${i + 1}`, callback_data: await token(db, ed, "swap_to", { storyId: story.id, storyVersion: story.version, payload: { articleId: alts[i].candidate.articleId } }) }]);
      }
      await client.sendMessage(chatId, `Replace <b>#${story.position}</b> “${esc(story.headline)}” with:\n\n${lines.join("\n\n")}`, { buttons });
      return;
    }
    case "swap_to": {
      const story = ed.stories.find((s) => s.id === a.storyId);
      if (!story || story.version !== a.storyVersion) return void (await client.answerCallback(cq.id, "The draft changed since these options were offered.", true));
      const cand = (await liveAnalysis(db, ed)).candidates.find((c) => c.articleId === a.payload.articleId);
      if (!cand) return void (await client.answerCallback(cq.id, "That article is no longer eligible.", true));
      const r = await applyCommand(db, actor, (e, at) => swapStory(e, { storyId: story.id, candidate: cand }, at));
      await markUsed(db, a.token);
      await client.answerCallback(cq.id, r.ok ? "Swapped" : r.error.message, !r.ok);
      if (r.ok) await client.sendMessage(chatId, esc(r.message ?? "Swapped."));
      return;
    }
    case "preview": {
      await client.answerCallback(cq.id);
      const settings = await getSettings(db);
      const email = renderEmail(snapshotOf(ed), { newsletterName: settings.newsletter.name, fromName: settings.sending.fromName, footer: settings.newsletter.footer }, { unsubscribeUrl: "(personal unsubscribe link)" });
      for (const page of paginate(`<b>Subject:</b> ${esc(email.subject)}\n<i>Revision ${ed.revision} · plain-text view</i>\n\n${esc(email.text)}`)) await client.sendMessage(chatId, page);
      return;
    }
    case "confirm_start": {
      await client.answerCallback(cq.id);
      return sendConfirmPrompt(db, client, chatId, ed, a.revision !== ed.revision);
    }
    case "confirm_final": {
      // Bound to an exact revision AND content hash: an old message can never
      // approve content that changed after it was sent.
      if (a.revision !== ed.revision || a.payload.contentHash !== contentHash(ed)) {
        await client.answerCallback(cq.id, "The draft changed since this message — nothing was approved.", true);
        return sendConfirmPrompt(db, client, chatId, ed, true);
      }
      const settings = await getSettings(db);
      const ctx = await finalisationContext(db);
      const m = milestonesFor(ed.publishDate, settings.schedule);
      const r = await applyCommand(db, actor, (e, at) =>
        confirmEdition(e, { revision: a.revision, contentHash: String(a.payload.contentHash), sendNow: false, sendAt: m.sendAt, channel: "telegram", sender: ctx.sender }, ctx, at),
      );
      await markUsed(db, a.token);
      if (r.ok) {
        await client.answerCallback(cq.id, "Confirmed ✓");
        await client.clearButtons(chatId, cq.message!.message_id).catch(() => undefined);
        await client.sendMessage(chatId, `Confirmed revision ${a.revision}. Scheduled for ${esc(formatInZone(m.sendAt, settings.schedule.timezone))}. Any further edit withdraws this approval.`);
      } else {
        await client.answerCallback(cq.id, "Not confirmed", true);
        await client.sendMessage(chatId, `Not confirmed: ${esc(r.error.message)}`);
      }
      return;
    }
  }
  await client.answerCallback(cq.id, "Unknown action.");
}

async function sendConfirmPrompt(db: Db, client: TelegramClient, chatId: string, ed: Edition, changed: boolean) {
  const settings = await getSettings(db);
  const ctx = await finalisationContext(db);
  const report = finalisationReport(ed, ctx);
  const m = milestonesFor(ed.publishDate, settings.schedule);
  const lines = [
    changed ? "<i>The draft changed since the earlier message. This is the current version:</i>\n" : "",
    `<b>Confirm the ${esc(formatYmd(ed.publishDate, "short"))} edition?</b>`,
    `Revision ${ed.revision} · ${ed.stories.length} stories · ${distinctTopics(ed.stories.map((s) => s.topic)).length} topics`,
    ...ed.stories.map((s) => `${s.position}. ${esc(s.headline)}`),
    "",
    `Recipients: ${ctx.eligibleRecipients} · From: ${esc(ctx.sender ?? "not connected")}`,
    `Send time: ${esc(formatInZone(m.sendAt, settings.schedule.timezone))}`,
  ];
  if (report.blockers.length) {
    lines.push("", "<b>Can't confirm yet:</b>", ...report.blockers.map((b) => `• ${esc(b)}`));
    return void (await client.sendMessage(chatId, lines.join("\n")));
  }
  if (Date.now() > Date.parse(m.sendAt) - 60_000) {
    lines.push("", "The usual send time has passed. Choose “Send now” or another time in the dashboard — late approvals are never sent automatically.");
    return void (await client.sendMessage(chatId, lines.join("\n"), { buttons: dashboardButton().length ? [dashboardButton()] : undefined }));
  }
  await client.sendMessage(chatId, lines.join("\n"), {
    buttons: [[{ text: `Confirm revision ${ed.revision}`, callback_data: await token(db, ed, "confirm_final", { payload: { contentHash: contentHash(ed) } }) }]],
  });
}

async function handleReplyEdit(db: Db, client: TelegramClient, chatId: string, msg: NonNullable<TgUpdate["message"]>) {
  const [r] = await db.query<Record<string, unknown>>(
    `select * from telegram_actions where workspace_id = $1 and action = 'edit_reply' and prompt_message_id = $2 and used_at is null and expires_at > now()`,
    [WORKSPACE_ID, String(msg.reply_to_message!.message_id)],
  );
  if (!r) return void (await client.sendMessage(chatId, "I couldn't match that reply to a story. Use the ✎ Edit button on a story first."));
  const text = (msg.text ?? "").trim();
  if (!text) return void (await client.sendMessage(chatId, "Send the new commentary as text."));
  const result = await applyCommand(db, "telegram:owner", (e, at) => editStory(e, { storyId: String(r.story_id), baseVersion: Number(r.story_version), patch: { commentary: text } }, at), { editionId: String(r.edition_id) });
  await markUsed(db, String(r.token));
  if (result.ok) await client.sendMessage(chatId, `Saved. ${esc(result.message ?? "")}`, { replyTo: msg.message_id });
  else await client.sendMessage(chatId, `Not saved: ${esc(result.error.message)}`, { replyTo: msg.message_id });
}

async function markUsed(db: Db, t: string) {
  await db.query(`update telegram_actions set used_at = now() where token = $1`, [t]);
}

export async function createLinkCode(db: Db): Promise<string> {
  const code = randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  await db.query(`update workspace_settings set telegram_link_code = $2, telegram_link_expires_at = now() + interval '30 minutes' where workspace_id = $1`, [WORKSPACE_ID, code]);
  return code;
}
