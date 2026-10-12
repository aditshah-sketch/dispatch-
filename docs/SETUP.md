# Integration setup guide

Every integration is optional except the database and owner sign-in (needed for the live desk). Each one switches on by itself when its variables are present. **Settings** shows its status, what's missing, and a safe connection test. Tests never send email or create events.

Changes to environment variables need a **redeploy** on Vercel. Locally, restart `npm run dev`.

---

## 1. Database (required for the live desk)

Any PostgreSQL works. On Vercel the simplest option is **Neon** from the Vercel Marketplace (Storage → Create → Neon). It injects `DATABASE_URL` automatically.

- Use the **pooled** connection string on serverless.
- Migrations run automatically on the first connection, guarded by an advisory lock. To run them explicitly: `DATABASE_URL=… npm run db:migrate`.
- Local development without installing Postgres: `DATABASE_URL=pglite:./.data/dispatch`. This uses embedded Postgres via PGlite with the same SQL and constraints. Production refuses it, because the Vercel filesystem is ephemeral.

## 2. Owner sign-in (required for the live desk)

Set `AUTH_SECRET` (random, 32+ bytes) and `OWNER_PASSWORD`. Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`AUTH_SECRET` also signs unsubscribe links. Rotating it breaks the links in emails already sent, so treat it as long-lived.

## 3. Gemini Flash

1. Create a key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY`.
2. `GEMINI_MODEL` defaults to `gemini-3.8-flash`, the latest stable Flash per ai.google.dev on 2026-10-12. Change it without code changes if Google retires or renames models.
3. Settings → Gemini → **Test connection** makes one tiny structured-output call.

The app calls the REST `generateContent` endpoint with a JSON schema and validates every response with zod. The current structured-output field is `responseFormat`. If the API rejects it, the client falls back once to `responseMimeType` + `responseJsonSchema`.

## 4. Google OAuth (Gmail sending, bounce feedback, Calendar)

1. **Google Cloud Console** → create a project.
2. **APIs & Services → Library**: enable the **Gmail API** and the **Google Calendar API**.
3. **OAuth consent screen**: user type *External*, or *Internal* on Workspace. Fill in the app name and support email. Add the scopes the features need:
   - `gmail.send` (sensitive): sending the newsletter
   - `gmail.readonly` (**restricted**): only for bounce feedback. External production use requires Google's restricted-scope verification and a security assessment, so leave it off unless needed.
   - `calendar.events` and `calendar.freebusy`: only for the optional Calendar features
   - `openid` and `email`: to show which account is connected
4. While the app is in **Testing**, add Shreya's Google account under **Test users**. Refresh tokens for external apps in Testing **expire after 7 days**; the app then shows *Needs attention → Reconnect*. Publish the app, or use an Internal Workspace app, to avoid this.
5. **Credentials → Create OAuth client ID → Web application**
   - Authorised redirect URI: `https://<your-domain>/api/google/callback`, and `http://localhost:3000/api/google/callback` for local development.
   - Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`. `GOOGLE_REDIRECT_URI` is optional and defaults to `<APP_BASE_URL>/api/google/callback`.
6. In the app: **Settings → Gmail → Connect Google**.
   - Each feature asks only for its own scopes, using incremental authorization (`include_granted_scopes=true`).
   - Tokens are stored encrypted (AES-256-GCM) and refreshed automatically.
   - Nobody pastes passwords or refresh tokens.

### Sending limits (important for 2,200 subscribers)

| Account | Daily limit (Google, Oct 2026) | Can it send 2,200 on Thursday morning? |
|---|---|---|
| Personal Gmail | ~500 recipients/day | **No** |
| Google Workspace | 2,000 messages/user/day (500 on trials) | **No** |

Separately, the Gmail API allows about 60 sends per minute per user (6,000 quota units per minute; `messages.send` costs 100). The app paces sends at about 1 per second.

The app blocks confirmation when active subscribers exceed the configured daily limit, and says why. It does **not** quietly spread a campaign across several days. The full list needs a bulk email provider: the sending interface (`providers/google.ts` → `gmailSend`, called only from `services/delivery.ts`) is the single place to swap one in. Gmail's bulk-sender rules for more than 5,000 messages a day also apply: SPF, DKIM, DMARC and one-click unsubscribe (implemented).

## 4b. Resend (recommended for sending)

Resend is the preferred sender when configured, and Gmail becomes optional. To use it:
1. Create an API key at https://resend.com/api-keys. **Sending access** is enough. Set `RESEND_API_KEY`.
2. **Domains → Add domain**, then add the DNS records it shows (SPF, DKIM, and optionally DMARC) and wait until the domain is *Verified*.
3. Set `RESEND_FROM=news@yourdomain.com`. The display name comes from Settings → Email.
   - Without a domain you can test with `onboarding@resend.dev`, but Resend then delivers **only to your own account email**.
4. **Webhooks → Add endpoint**:
   - URL: `https://<your-domain>/api/resend/webhook`
   - Events: `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`, `email.delivered`
   - Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET`.
5. Settings → Resend → **Test connection**. It reads your domains and sends nothing.
6. Settings → Email → set **Account type: Resend** and the daily limit to match your plan: 100 on Free, or your monthly allowance on paid plans.

How it behaves:
- One recipient per request.
- `Idempotency-Key` = delivery ID, so a request that times out is retried once safely. Resend keeps keys for 24 hours and won't send twice.
- Pacing is about 6 requests per second, under Resend's default of 10 per second.
- `List-Unsubscribe` and one-click headers are on every message.
- Webhooks are verified with the Svix HMAC signature and a 5-minute replay window. They are processed only when matched to an email this app sent.
- Permanent bounce → suppressed. Temporary bounce → recorded, and suppressed after 3 in separate editions. Delay → recorded only. Spam complaint → stops all future sends.
- A campaign keeps the provider it started with, even if settings change mid-send.

**Plan limits (Oct 2026):** Free is 100 a day and 3,000 a month. Pro is $20/month for 50,000 a month with no daily cap. That's enough for 2,200 subscribers every Thursday, once the domain is verified.

## 5. Telegram

1. Message **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_WEBHOOK_SECRET` to a random string of `A–Z a–z 0–9 _ -`, up to 256 characters.
3. Deploy, so `APP_BASE_URL` is public HTTPS.
4. **Settings → Telegram**:
   - **Generate code**, then send `/start CODE` to your bot from your own account. This links your private chat; the code is single-use and expires after 30 minutes.
   - **Register webhook**. This calls `setWebhook` with the secret token; Telegram then sends it in `X-Telegram-Bot-Api-Secret-Token` on every update.
   - Alternatively, pin `TELEGRAM_OWNER_CHAT_ID`.
5. **Test connection** shows the bot name and webhook status.

How it behaves:
- Story buttons are Approve, Edit (reply-based), and Swap (up to 3 alternatives). Preview email and "Review & confirm…" are offered once at the end.
- Every button is an opaque token stored on the server, bound to the edition, revision and story version.
- An old message can't approve changed content: the final confirmation re-checks the revision and content hash.
- Updates from any other chat are ignored and audited. Redelivered updates are deduplicated by `update_id`.

## 6. GNews (news search, optional)

Sign up at https://gnews.io and set `GNEWS_API_KEY`.

- The **free plan** has a ~12-hour delay, 10 results per request and 100 requests a day, and is **non-commercial**. Set `GNEWS_PLAN=paid` on a paid plan.
- Queries are editable on the Articles page under Sources.
- Without a key, query sources show *Skipped* and RSS collection still runs.

## 7. ScrapingBee (optional)

Set `SCRAPINGBEE_API_KEY`. Pages are fetched only for articles in this week's window whose feed text is thin. Limits:
- up to `SCRAPINGBEE_MAX_PAGES_PER_RUN` pages (default 25)
- JavaScript rendering is off by default: 1 credit instead of 5
- 20-second timeout

Known paywalled hosts are never fetched; their articles are recorded as *BLOCKED*. Every article is attempted at most once, which acts as a cache.

## 8. Vercel deployment

```bash
vercel deploy --prod
```

Or connect the GitHub repository in the Vercel dashboard. Then:
- **Environment variables**: add everything from `.env.example` that you use, then redeploy.
- **Cron jobs** (`vercel.json`): six entries, each running at most once a day, so they're compatible with the Hobby plan:

| Purpose | IST | UTC cron |
|---|---|---|
| Collect | Mon–Wed 08:00 | `30 2 * * 1-3` |
| Generate draft | Wed 15:00 | `30 9 * * 3` |
| Draft to Telegram | Wed 18:00 | `30 12 * * 3` |
| Approval reminder | Wed 22:00 | `30 16 * * 3` |
| Send | Thu ~09:02 | `32 3 * * 4` |
| Bounce check | daily 11:30 | `0 6 * * *` |

  - **Hobby timing limitation:** Vercel runs Hobby crons once a day, anywhere within the scheduled hour. The 10 PM reminder may arrive as late as 10:59 PM.
  - For exact timing, either upgrade to Pro and replace the entries with one `*/5 * * * *` call to `/api/cron/tick`, or enable the included GitHub Actions workflow (`.github/workflows/scheduler.yml`) by adding repository secrets `DISPATCH_URL` and `CRON_SECRET`.
  - Every tick recomputes what's due, so extra or duplicate calls are harmless.
  - If you change the schedule in Settings, update the cron entries too, or rely on a frequent external tick.
- **Function duration**: routes set `maxDuration = 300` (the Hobby maximum with Fluid compute). Long sends run in resumable batches: each invocation sends for up to about 4.5 minutes, checkpoints in the database, and triggers the next batch.
