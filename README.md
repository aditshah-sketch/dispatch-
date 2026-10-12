# The Dispatch — Newsletter Intelligence Engine

A weekly editorial desk for **The Dispatch**, a curated newsletter on India's startup ecosystem. It collects stories Monday to Wednesday and filters out duplicates, repeat coverage of one event, and stories from the last four editions. It then drafts 8–10 stories with Gemini Flash, lets the editor review on the dashboard or in Telegram, and sends **only after explicit confirmation** of one exact revision.

**Collect → Review → Approve → Deliver**, plus an optional *Plan follow-up → Review details → Confirm and book* flow.

- **Public preview**: `/preview` runs the whole journey with fictional sample data in your browser. It never fetches, emails, messages or books anything; those results are labelled *simulated*.
- **Live desk**: `/desk` is owner-only and uses durable Postgres and real integrations.
- Components Map: [docs/COMPONENTS_MAP.md](docs/COMPONENTS_MAP.md). Integration setup: [docs/SETUP.md](docs/SETUP.md).

## Quick start

```bash
npm install
cp .env.example .env.local
# Minimum for the live desk locally:
#   DATABASE_URL=pglite:./.data/dispatch   (embedded Postgres, no install)
#   AUTH_SECRET=<random>  OWNER_PASSWORD=<passphrase>  TOKEN_ENCRYPTION_KEY=<random>  CRON_SECRET=<random>
npm run dev        # http://localhost:3000 — /preview works with no env at all
```

| Command | What it does |
|---|---|
| `npm test` | Unit + integration tests (Vitest, real embedded Postgres, all external APIs mocked) |
| `npm run test:e2e` | Browser tests of the preview journey (Playwright, uses installed Chrome). If a dev server already runs in this folder: `E2E_PORT=<its port> npm run test:e2e` |
| `npm run lint` / `npm run typecheck` | ESLint (incl. React Compiler rules) / TypeScript |
| `npm run build` | Production build (works with zero environment variables) |
| `npm run db:migrate` | Apply migrations explicitly (they also auto-apply on first connection) |

## Architecture in one paragraph

Next.js 16 (App Router, TypeScript, Tailwind 4) on Vercel, with PostgreSQL behind a tiny SQL interface: postgres.js in production, PGlite locally and in tests.
- **Domain rules** (`src/lib/domain`) are pure functions shared by the browser preview and the server: edition commands, validation, clustering, history, schedule, email rendering. Both modes therefore enforce identical rules.
- **Providers** (`src/lib/server/providers`) wrap each external API.
- **Services** (`src/lib/server/services`) run the workflow.
- A **durable job outbox** (`jobs` table with dedupe keys, leases, retry budgets and checkpoints) is driven by an authenticated tick endpoint. Nothing relies on in-memory timers.

## How the requirements are met

| Requirement | Implementation |
|---|---|
| Ingest Mon–Wed from RSS + news API | 12 verified RSS feeds + 4 news-search queries (Google News search, key-free; GNews API used instead when `GNEWS_API_KEY` is set); bounded concurrency (4), per-source isolation, idempotent upsert on normalised URL |
| Duplicates & overlapping coverage | Exact: normalised URL (tracking params stripped conservatively) + content fingerprint, with DB uniqueness. Same event: deterministic star clustering (entities, event type, amounts, text similarity), refined by Gemini's `sameEventAs`. Corroborating sources are kept on the story |
| Exclude last 4 *published* editions | `published_story_refs` written when the first copy is accepted. Same event → excluded. Same company, different development → eligible but flagged. Partial history (<4) is shown, never claimed complete |
| Wed afternoon Gemini selection, 8–10 stories, ≥3 topics | Staged: deterministic filter → batch evaluation (rubric) → selection → commentary → deterministic validation. One repair attempt, then a deterministic fill. Never pads with invented stories |
| Commentary with style guide | Versioned style guide (labelled starter guide) plus optional examples; 2–3 sentences. Quotes and amounts must appear in the source or the text is rejected; unsupported numbers are flagged |
| Draft via Telegram Wed evening | Scheduled job; story cards with Approve / Edit / Swap; preview; distinct confirmation flow bound to revision + content hash |
| Explicit confirmation; never send on silence | `confirmEdition` requires the current revision + hash. The send job re-verifies approval and frozen snapshot. Reminders, deadlines and story approvals can't authorise a send |
| Wed 10 PM reminder | Once per edition (dedupe key `reminder:<date>`), Telegram plus in-app; it says plainly that nothing will be sent without confirmation |
| Thursday delivery | Approved snapshot frozen at approval; resumable batches; one recipient per message; suppression rechecked before each send |
| Unsubscribes & bounces | Signed per-subscriber link → confirmation page (GET never unsubscribes) + RFC 8058 one-click POST. Bounces parsed from DSNs and matched to known deliveries: permanent → suppressed; temporary → recorded, suppressed after 3 across editions |
| Calendar | Optional review blocks and follow-up meetings. Separate *Confirm and book* tied to a hash of the reviewed details; deterministic event IDs prevent duplicates; Meet links come only from Google |

**Interpretation of "unsubscribes from Gmail bounces":** I treat it as two separate mechanisms. Unsubscribe is a reader's request. Bounce suppression is a delivery fact. A bounce never marks someone as "unsubscribed", and an unsubscribe is never inferred from email text.

## Operating modes

- **Preview** (`/preview`):
  - client-only state in `localStorage`, isolated per browser, with a Reset button
  - fictional companies and `example.com` links
  - prewritten "Sample commentary (prewritten)", never labelled AI
  - simulated Telegram, email and Calendar results
- **Connected** (`/desk`): needs `DATABASE_URL` + `AUTH_SECRET` + `OWNER_PASSWORD`. Each other integration activates independently:

| Integration | Effect when present | Without it |
|---|---|---|
| RSS | Always on | — |
| Gemini | Draft generation | Manual curation from Articles; nothing labelled AI |
| Telegram | Review channel | Drafts and reminders appear in-app |
| Resend (preferred) or Gmail | Sending | Confirmation is blocked with a clear reason |
| GNews / ScrapingBee / Calendar / bounce feedback | Optional extras | — |

Status words: *Not connected*, *Ready*, *Needs attention*, *Unavailable*.

## Scheduling (Asia/Kolkata, editable in Settings)

Collection Mon–Wed 08:00 · draft Wed 15:00 · draft to Telegram Wed 18:00 · **reminder Wed 22:00** (fixed by the brief) · send Thu 09:00. Only the reminder time comes from the case; the rest are assumptions.

`vercel.json` holds Hobby-compatible daily crons, converted to UTC (see [docs/SETUP.md](docs/SETUP.md#8-vercel-deployment)). **Limitation:** Hobby crons fire once a day and up to ~59 minutes late, so the 10 PM reminder may arrive as late as 10:59 PM. For precise timing, use Vercel Pro with a `*/5` tick, or the included GitHub Actions scheduler. "Run a scheduled step now" controls on This Week call the same services, for demos on any day.

**Late approval:** a passed send time is never converted into an immediate send. The confirm dialog asks for *Send now* or a later time.

## Security

- **Owner auth:** a signed, HTTP-only session cookie; login is rate-limited in the database.
- **Proxy gate** on `/desk` and `/api/desk`; signature verification in every handler; Origin check on mutations.
- **Endpoint secrets:** `CRON_SECRET` bearer on `/api/cron/*`; Telegram secret header plus owner-chat restriction plus update dedupe.
- **OAuth:** state is signed and bound to a cookie nonce. Google tokens are AES-256-GCM encrypted in the database.
- **Outbound fetches** for feeds block private, link-local and metadata addresses, revalidate every redirect hop, and limit time and size.
- **Output safety:** all source and AI text is escaped before HTML rendering.
- **Rate limits** on generation, collection and unsubscribe.
- **No secrets in the client:** verified that no secret value appears in `.next/static`.

## Test results (run 2026-10-12)

- `npm test`: **47 passed / 47**. Domain rules plus integration tests against real embedded Postgres; every external API mocked at `fetch`, no real sends.
- `npm run test:e2e`: **5 passed / 5** (desktop + mobile Chrome).
- `npm run lint` and `npm run typecheck`: clean.
- `npm run build`: succeeds, both with and without environment variables.
- **Live checks performed locally:**
  - real RSS collection from all 12 feeds: 347 items; a re-run inserted 0 duplicates
  - clustering reviewed by hand on real data: 23 multi-source events, largest 4; one false merge found and fixed with a regression test
  - authenticated cron ticks (duplicate tick was a no-op)
  - unauthenticated access rejected
  - manual curation of 8 real stories with correct blockers

Required checks → tests:
1. Preview without keys — build + e2e
2. Preview can't send — e2e asserts zero requests to `/api/desk`, `/api/cron` or external hosts
3. Repeat ingestion — server test
4. Overlapping events — domain + real-data check
5. Previous coverage excluded — domain test
6. Same company, new development eligible — domain test
7. Count/topic validation — domain test
8. Unknown AI IDs rejected — server test
9. Invalid AI output bounded — server test (exactly 1 call, edition not stuck)
10. Insufficient input → honest incomplete draft — server test
11. Failed source isolated — server test
12. Stale edits rejected — domain + server tests
13. Story approval ≠ publish — domain + server + e2e
14. Approval bound to revision — domain + server tests
15. Edit after approval → reconfirm + cancelled job — domain + server + e2e
16. Send without approval blocked server-side — server test
17. Duplicate cron → one campaign — server test (concurrent runs)
18. Ambiguous Gmail result not resent — server test
19. Unsubscribed excluded at send time — server test (unsubscribes mid-campaign)
20. Permanent vs temporary bounces — server test
21. Telegram unauthorised / stale / duplicate — server test
22. Calendar needs confirmation — server + e2e
23. No duplicate events — server test
24. Truthful failure states — server tests (quota pause, Telegram failure)
25. No secrets in preview — bundle scan

## Evaluator walkthrough (5 minutes, no credentials)

1. Open `/` → **Open the interactive preview**. The banner says sample data.
2. *This Week* shows the edition date, publication target in IST, the stage, collection stats and the partial history check (3 of 4).
3. **Articles**: filter *Same event*, *Duplicates* and *Already covered* to see why each was excluded. Sources are listed.
4. **Generate sample draft**: 9 stories across 7 topics. Commentary is labelled prewritten.
5. Open *Scoring & sources* and *Why it's here* on a story.
6. Edit a commentary. It autosaves and the label becomes *Edited by you*.
7. **Swap** a story; the dialog shows the topic-coverage impact.
8. **Confirm and schedule** shows the exact email (HTML and plain text), recipients, sender and send time.
9. Confirm. Then edit any story: the approval is withdrawn. Confirm again.
10. *Run a scheduled step now* → **simulate delivery**. The report is labelled *Simulated — no email sent*.
11. On a story: **More → Plan follow-up…** → Review details → *Confirm and book (simulated)*.
12. **Reset preview** (sidebar) to start over.

On the live desk (`/desk`, owner password), the same screens use real data, and Settings shows which integrations are connected.

## Readiness

| Feature | Implemented | Tested locally | Tested live | Remaining dependency |
|---|---|---|---|---|
| Preview journey | Yes | Yes (e2e) | Yes (deployed preview) | — |
| **Full live journey** | Yes | Yes | **Yes** — Collect (RSS + news search) → Gemini draft → Telegram review → owner confirmation → Resend delivery → 9 stories saved to editorial memory | — |
| RSS ingestion + dedupe + clustering | Yes | Yes | **Yes** — production run: 337 items, 11/12 feeds (MediaNama blocks cloud IPs → now relayed via ScrapingBee) | — |
| Durable storage | Yes | Yes (PGlite) | **Yes** — Supabase (Mumbai) via Vercel, migrations applied, REST access locked down | — |
| Owner auth | Yes | Yes | Configured on Vercel; owner sign-in to be done by the owner | — |
| Gemini drafting | Yes | Yes | **Yes** — `gemini-3.8-flash` on production: 9-story, 7-topic draft from live articles in 63 s (locally the evidence check rejected one unsupported amount) | — |
| News search queries | Yes | Yes | **Yes** — Google News search (no key): 4 live queries returned 79 results, matched to RSS coverage as same-event | Optional `GNEWS_API_KEY` for the GNews API |
| ScrapingBee | Yes | Yes | **Yes** — production run: 19 pages extracted, 7 paywalled skipped, 25-credit budget respected | — |
| Telegram review + reminders | Yes | Yes | **Yes** — owner chat linked; production draft delivered to Telegram | — |
| Resend send + webhooks | Yes | Yes | **Yes** — first edition approved by the owner and sent end to end on production (2026-10-12): campaign SENT, delivery ACCEPTED, signed `email.delivered` webhook received; idempotent retry verified | A verified sending domain to reach recipients other than the account owner |
| Gmail OAuth + send | Yes | Yes (mocked API) | **No** | Google OAuth client, consent-screen setup |
| Bounce processing | Yes | Yes (mocked API) | **No** | `gmail.readonly` grant (restricted scope) |
| Calendar | Yes | Yes (mocked API) | **No** | Google OAuth with Calendar scopes |
| Scheduler | Yes | Yes | **Yes** — authenticated production tick ran Monday's collection; Vercel crons in `vercel.json` | Hobby timing ±59 min (or external scheduler) |

## Assumptions

- **One owner, one workspace** (`workspace_id = 'default'`). No billing, teams or onboarding.
- **Collection window:** from the previous edition's send time (last Thursday 09:00 IST) to now. Each edition is identified by its publish date: one row per workspace per Thursday.
- **Topic taxonomy:** a fixed list of 10 topics plus "other". "Other" never counts toward the 3-topic minimum.
- **Approval scope:** story-level approvals are review markers only. Final confirmation approves all included stories at once.
- **Editorial memory:** an edition counts as published once ≥1 copy is accepted. Imported history counts too.
- **Temporary bounces:** suppressed after 3, in separate editions.
- **Preview dates:** sample article dates are placed inside the current week's window so the workflow is demonstrable. The UI never claims they were fetched.

## Known limitations and pending live checks

- **Use Resend (Pro) for the full list:** it has no daily cap, and 50,000 a month covers 2,200 a week. Gmail is kept as an alternative.
- **Gmail can't deliver 2,200 messages in one morning:** about 500/day on personal Gmail, about 2,000/day on Workspace, and at most ~60/min through the API. The app blocks confirmation above the configured limit instead of silently spreading delivery. A bulk provider is the real fix; the send interface is isolated for that.
- **Untested against the live services:** Gemini, Telegram, Gmail, Calendar, GNews and ScrapingBee have only been exercised against mocks. Live verification needs the credentials above. One open detail: whether Gemini accepts the `responseFormat` field (with the automatic fallback) is confirmed only against the docs.
- **Google consent screen:** in *Testing* status, refresh tokens expire after 7 days (the app shows *Reconnect*). `gmail.readonly` needs Google verification for external production use.
- **Hobby cron precision:** see Scheduling above.
- **Uncertain sends:** a Gmail call that times out is recorded as *UNKNOWN* and never retried automatically. "Resend uncertain" asks for confirmation, and first checks Sent mail when read access exists.
- **Found in production and fixed:** postgres.js double-encoded JSON parameters (PGlite doesn't), so some settings and job payloads were stored as JSON strings. The fix casts through text, migration 5 repaired the stored rows, and a regression test was added. Integration tests run on PGlite; production behaviour was checked against Supabase directly.
- **DNS rebinding:** feed URLs are validated before each request and redirect, but not pinned to the resolved IP.

## Deployment

- **Vercel:** `vercel deploy --prod` from this folder. Add the env vars from `.env.example`, then redeploy. Details: [docs/SETUP.md](docs/SETUP.md).
- **Deployment URL:** https://the-dispatch-liard.vercel.app (Vercel production, deployed 2026-10-12). Preview verified working there. The live desk shows its setup screen until `DATABASE_URL`, `AUTH_SECRET` and `OWNER_PASSWORD` are added. The scheduler returns 503 until `CRON_SECRET` is set.
- **GitHub repository:** https://github.com/aditshah-sketch/dispatch-
