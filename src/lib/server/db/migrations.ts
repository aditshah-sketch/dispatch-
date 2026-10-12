// Ordered, append-only migrations. Statements are separated by ";\n".
// Applied automatically on first connection (guarded by an advisory lock) and
// also runnable with `npm run db:migrate`.

export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: "initial schema",
    sql: `
create table workspaces (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);
insert into workspaces (id, name) values ('default', 'The Dispatch') on conflict do nothing;

create table workspace_settings (
  workspace_id text primary key references workspaces(id),
  schedule jsonb not null,
  sending jsonb not null,
  newsletter jsonb not null,
  telegram_chat_id text,
  telegram_link_code text,
  telegram_link_expires_at timestamptz,
  gmail_history_checked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table sources (
  id text primary key,
  workspace_id text not null references workspaces(id),
  kind text not null check (kind in ('rss','news_query')),
  name text not null,
  locator text not null,
  enabled boolean not null default true,
  verified_note text,
  last_run_at timestamptz,
  last_status text check (last_status in ('OK','FAILED','EMPTY','SKIPPED')),
  last_error text,
  last_item_count int,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, locator)
);

create table articles (
  id text primary key,
  workspace_id text not null references workspaces(id),
  source_id text references sources(id) on delete set null,
  publisher text not null,
  url text not null,
  normalized_url text not null,
  headline text not null,
  author text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  description text,
  extracted_text text,
  fingerprint text,
  extraction_status text not null default 'FEED_ONLY',
  extraction_attempted_at timestamptz,
  provenance text not null,
  topic text,
  topic_origin text,
  cluster_id text,
  evidence_notes jsonb not null default '[]',
  unique (workspace_id, normalized_url)
);
create index articles_ws_published on articles (workspace_id, published_at desc);
create index articles_fingerprint on articles (workspace_id, fingerprint);

create table ingestion_runs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  edition_publish_date date,
  trigger text not null,
  status text not null check (status in ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}',
  source_results jsonb not null default '[]'
);

create table style_guides (
  workspace_id text not null references workspaces(id),
  version int not null,
  content text not null,
  examples text not null default '',
  is_starter boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (workspace_id, version)
);

create table editions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  publish_date date not null,
  issue_number int,
  subject text not null default '',
  intro text not null default '',
  status text not null check (status in ('COLLECTING','DRAFTING','IN_REVIEW','SCHEDULED','SENDING','SENT','PARTIALLY_SENT','FAILED','CANCELLED')),
  revision int not null default 0,
  lock_version int not null default 0,
  generated_by text,
  draft_notes jsonb not null default '[]',
  published_at timestamptz,
  origin text not null default 'workflow' check (origin in ('workflow','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, publish_date)
);

create table edition_stories (
  id text primary key,
  edition_id text not null references editions(id) on delete cascade,
  article_id text references articles(id),
  position int not null,
  headline text not null,
  publisher text not null,
  url text not null,
  published_at timestamptz,
  topic text not null,
  commentary text not null default '',
  commentary_origin text not null,
  rationale text not null default '',
  rationale_origin text not null,
  scores jsonb,
  warnings jsonb not null default '[]',
  corroborating jsonb not null default '[]',
  review_status text not null default 'PENDING',
  version int not null default 1,
  style_guide_version int,
  cluster_id text,
  history_note text,
  unique (edition_id, article_id)
);

create table edition_revisions (
  edition_id text not null references editions(id) on delete cascade,
  revision int not null,
  content_hash text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (edition_id, revision)
);

create table approvals (
  id text primary key,
  edition_id text not null references editions(id),
  revision int not null,
  content_hash text not null,
  approved_by text not null,
  approved_at timestamptz not null,
  channel text not null,
  send_at timestamptz not null,
  send_now boolean not null,
  recipient_count int not null,
  sender text,
  revoked_at timestamptz,
  revoked_reason text,
  foreign key (edition_id, revision) references edition_revisions(edition_id, revision)
);

create table published_story_refs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  edition_id text not null references editions(id),
  publish_date date not null,
  article_id text,
  normalized_url text not null,
  headline text not null,
  description text,
  published_at timestamptz,
  unique (edition_id, normalized_url)
);

create table subscribers (
  id text primary key,
  workspace_id text not null references workspaces(id),
  email text not null,
  email_normalized text not null,
  name text,
  status text not null check (status in ('ACTIVE','UNSUBSCRIBED','BOUNCED')),
  status_reason text,
  temp_failures int not null default 0,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, email_normalized)
);

create table campaigns (
  id text primary key,
  workspace_id text not null references workspaces(id),
  edition_id text not null references editions(id),
  revision int not null,
  content_hash text not null,
  approval_id text not null references approvals(id),
  status text not null check (status in ('SENDING','SENT','PARTIALLY_SENT','FAILED','CANCELLED')),
  snapshot jsonb not null,
  paused_until timestamptz,
  paused_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (edition_id, revision)
);
create unique index campaigns_one_active on campaigns (edition_id) where status = 'SENDING';

create table deliveries (
  id text primary key,
  campaign_id text not null references campaigns(id),
  subscriber_id text not null references subscribers(id),
  email text not null,
  status text not null check (status in ('PENDING','SENDING','ACCEPTED','FAILED_TEMPORARY','FAILED_PERMANENT','UNKNOWN','SKIPPED_UNSUBSCRIBED')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  provider_message_id text,
  provider_thread_id text,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (campaign_id, subscriber_id)
);
create index deliveries_campaign_status on deliveries (campaign_id, status);
create index deliveries_thread on deliveries (provider_thread_id);

create table delivery_feedback (
  id text primary key,
  workspace_id text not null references workspaces(id),
  provider_message_id text not null,
  kind text not null check (kind in ('PERMANENT_BOUNCE','TEMPORARY_BOUNCE','UNPARSEABLE','UNMATCHED')),
  recipient text,
  delivery_id text references deliveries(id),
  status_code text,
  detail text,
  processed_at timestamptz not null default now(),
  unique (workspace_id, provider_message_id)
);

create table integration_credentials (
  workspace_id text not null references workspaces(id),
  provider text not null,
  encrypted text not null,
  scopes jsonb not null default '[]',
  account_email text,
  status text not null default 'READY',
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);

create table integration_health (
  workspace_id text not null references workspaces(id),
  integration text not null,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  primary key (workspace_id, integration)
);

create table jobs (
  id text primary key,
  workspace_id text not null references workspaces(id),
  kind text not null,
  dedupe_key text not null,
  status text not null check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 3,
  lease_until timestamptz,
  stage text,
  payload jsonb not null default '{}',
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
create index jobs_due on jobs (status, run_at);

create table notifications (
  id text primary key,
  workspace_id text not null references workspaces(id),
  edition_id text references editions(id),
  kind text not null,
  channel text not null,
  status text not null,
  revision int,
  detail text not null,
  created_at timestamptz not null default now()
);

create table audit_events (
  id text primary key,
  workspace_id text not null references workspaces(id),
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity_type text,
  entity_id text,
  message text not null,
  details jsonb not null default '{}'
);
create index audit_ws_at on audit_events (workspace_id, at desc);

create table telegram_updates (
  update_id text primary key,
  received_at timestamptz not null default now()
);

create table telegram_actions (
  token text primary key,
  workspace_id text not null references workspaces(id),
  edition_id text not null references editions(id),
  revision int not null,
  story_id text,
  story_version int,
  action text not null,
  payload jsonb not null default '{}',
  prompt_message_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index telegram_actions_prompt on telegram_actions (prompt_message_id);

create table calendar_actions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  edition_id text references editions(id),
  story_id text,
  kind text not null check (kind in ('REVIEW_BLOCK','DEADLINE_ALERT','MEETING')),
  status text not null check (status in ('DRAFT','CREATING','CREATED','FAILED','UNKNOWN')),
  details jsonb not null,
  confirmed_at timestamptz,
  confirmed_details_hash text,
  external_event_id text not null,
  event_url text,
  meet_url text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, external_event_id)
);

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
)
`,
  },
  {
    id: 2,
    name: "email provider per campaign (Gmail or Resend)",
    sql: `
alter table campaigns add column if not exists provider text not null default 'gmail';
alter table deliveries add column if not exists delivered_at timestamptz;
create index if not exists deliveries_provider_message on deliveries (provider_message_id)
`,
  },
  {
    id: 3,
    name: "lock tables to the server connection (Supabase exposes public schema over REST)",
    // RLS with no policies denies API roles; the app connects as the table
    // owner, which bypasses RLS. Harmless on plain Postgres and PGlite.
    sql: `
alter table workspaces enable row level security;
alter table workspace_settings enable row level security;
alter table sources enable row level security;
alter table articles enable row level security;
alter table ingestion_runs enable row level security;
alter table style_guides enable row level security;
alter table editions enable row level security;
alter table edition_stories enable row level security;
alter table edition_revisions enable row level security;
alter table approvals enable row level security;
alter table published_story_refs enable row level security;
alter table subscribers enable row level security;
alter table campaigns enable row level security;
alter table deliveries enable row level security;
alter table delivery_feedback enable row level security;
alter table integration_credentials enable row level security;
alter table integration_health enable row level security;
alter table jobs enable row level security;
alter table notifications enable row level security;
alter table audit_events enable row level security;
alter table telegram_updates enable row level security;
alter table telegram_actions enable row level security;
alter table calendar_actions enable row level security;
alter table rate_limits enable row level security;
alter table schema_migrations enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on all tables in schema public from anon, authenticated; revoke all on all sequences in schema public from anon, authenticated; end if; end $$
`,
  },
  {
    id: 4,
    name: "deny API roles on tables created later",
    sql: `
do $$ begin if exists (select 1 from pg_roles where rolname = 'anon') then alter default privileges in schema public revoke all on tables from anon, authenticated; alter default privileges in schema public revoke all on sequences from anon, authenticated; end if; end $$
`,
  },
];
