// Runs once when the Node.js server starts. Only used to start the
// local-development Telegram poller (see services/telegram-poller.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL) return;
  const { startTelegramPoller } = await import("./lib/server/services/telegram-poller");
  startTelegramPoller();
}
