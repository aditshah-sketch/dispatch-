# Components Map — The Dispatch

How data flows from sources to subscribers, where AI is used, where human approval is required, and which steps have external effects.

```mermaid
flowchart LR
  subgraph Sources["Sources (Mon–Wed)"]
    RSS["12 RSS feeds<br/>(verified 2026-10-12)"]
    GN["GNews search API<br/>(optional)"]
  end

  subgraph Collect["Collect"]
    ING["Ingestion<br/>services/ingestion.ts<br/>bounded concurrency · per-source isolation"]
    SB["ScrapingBee<br/>(optional, thin articles only,<br/>credit budget, no paywall bypass)"]
    NORM["Normalise URLs · fingerprints<br/>idempotent upsert"]
  end

  DB[("Postgres<br/>articles · editions · revisions<br/>approvals · deliveries · jobs · audit")]

  subgraph Review["Review"]
    AN["Deterministic analysis<br/>domain/analysis.ts<br/>duplicates · window · last-4-editions · event clusters"]
    GEM["Gemini Flash<br/>services/drafting.ts<br/>evaluate → select → commentary<br/>(schema-validated, 1 repair max)"]
    VAL["Deterministic validation<br/>8–10 stories · ≥3 topics<br/>known IDs · evidence checks"]
    DASH["Dashboard (owner)<br/>edit · swap · remove · approve"]
    TG["Telegram bot<br/>tokens bound to revision"]
  end

  subgraph Approve["Approve — HUMAN GATE"]
    CONF["Final confirmation<br/>exact revision + content hash<br/>→ frozen snapshot"]
  end

  subgraph Deliver["Deliver (Thu)"]
    SCHED["Scheduler + job outbox<br/>/api/cron/* · leases · dedupe keys"]
    SEND["Send job<br/>re-verifies approval · resumable batches<br/>suppression recheck per recipient"]
    GM["Gmail API<br/>one recipient per message"]
  end

  SUBS[("Subscribers")]
  FB["Bounce processing<br/>(optional gmail.readonly)"]
  UNSUB["Unsubscribe page + RFC 8058 one-click"]
  CAL["Google Calendar<br/>(optional) review blocks · meetings<br/>separate Confirm & book"]

  RSS --> ING
  GN --> ING
  ING --> NORM --> DB
  ING -. thin text .-> SB -.-> DB
  DB --> AN --> GEM --> VAL --> DB
  DB <--> DASH
  DB <--> TG
  DASH --> CONF
  TG --> CONF
  CONF --> DB
  SCHED --> SEND
  DB --> SEND --> GM --> SUBS
  GM -. bounce notices .-> FB --> SUBS
  SUBS -. clicks .-> UNSUB --> SUBS
  DASH -. "Plan follow-up" .-> CAL

  classDef gate fill:#f4e4da,stroke:#9c3d1f,color:#1d1b18;
  classDef ext fill:#e1eaf2,stroke:#2f5476,color:#1d1b18;
  class CONF gate;
  class GM,TG,CAL,SB,GEM,GN,RSS ext;
```

## External effects and their gates

| Effect | Component | What authorises it | What never authorises it |
|---|---|---|---|
| Email to subscribers | `services/delivery.ts` → Gmail API | A valid, unrevoked final approval of the **current revision** whose frozen snapshot hash matches the content; send time reached (or "Send now" chosen explicitly) | Generated drafts, story approvals, reminders, deadlines passing, calendar events, background jobs |
| Telegram messages to the owner | `services/telegram-bot.ts` | Scheduled draft delivery (Wed 6 PM), the once-per-edition 10 PM reminder, or an owner action | — (only the linked owner chat receives anything) |
| Calendar event / invitations | `services/calendar.ts` | An explicit "Confirm and book" carrying a hash of exactly the reviewed details | Newsletter approval, story approval, AI suggestions |
| Article page fetch | `providers/scrapingbee.ts` | Collection run, thin feed text, within the per-run credit budget | Paywalled hosts (recorded as BLOCKED instead) |
| AI processing | `providers/gemini.ts` | Draft generation, single-story regeneration, meeting agenda suggestion | Article content (treated as untrusted data; cannot trigger tools or sends) |

## State machine (editorial)

```mermaid
stateDiagram-v2
  [*] --> COLLECTING
  COLLECTING --> DRAFTING: Generate draft (Gemini)
  DRAFTING --> IN_REVIEW: draft saved (complete or honestly incomplete)
  DRAFTING --> COLLECTING: generation failed (nothing lost)
  COLLECTING --> IN_REVIEW: first story added by hand
  IN_REVIEW --> SCHEDULED: final confirmation of revision N
  SCHEDULED --> IN_REVIEW: any content edit / withdraw (approval revoked, send job cancelled)
  SCHEDULED --> SENDING: send job verifies approval + snapshot
  SENDING --> SENT
  SENDING --> PARTIALLY_SENT
  SENDING --> FAILED
```

An edition enters editorial memory (the "previous four editions" check) as soon as the first recipient's copy is accepted, so a partially sent campaign is never forgotten.

## Module map

| Layer | Path | Notes |
|---|---|---|
| Pure domain rules (shared by preview + server) | `src/lib/domain/*` | edition commands, validation, clustering, history, schedule, email rendering |
| Preview engine (browser only) | `src/lib/client/preview-engine.ts` | sample data in localStorage; every effect simulated and labelled |
| Live client | `src/lib/client/client.ts` | JSON calls to owner-only API |
| Providers (external APIs) | `src/lib/server/providers/*` | Gemini, Telegram, Google (OAuth/Gmail/Calendar), ScrapingBee, RSS/GNews |
| Services (workflow) | `src/lib/server/services/*` | ingestion, drafting, editorial, delivery, feedback, telegram-bot, calendar, scheduler, views |
| Persistence | `src/lib/server/db/*`, `src/lib/server/repo/*` | Postgres (postgres.js) or PGlite locally; migrations auto-applied |
| HTTP | `src/app/api/*`, `src/proxy.ts` | owner session, cron secret, Telegram secret header, one-click unsubscribe |
