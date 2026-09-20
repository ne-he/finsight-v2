-- FinSight v2 schema.
--
-- Every object is prefixed `fs_` because this project shares one Supabase
-- instance with another app. The free plan allows only two active projects, so
-- namespacing by prefix is cheaper than spending a slot, and it keeps the two
-- apps' tables obviously separate in the dashboard.
--
-- Run order: 0001_schema, 0002_rls, 0003_search, 0004_rate_limit.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles: application role on top of Supabase Auth.
-- ---------------------------------------------------------------------------
-- Deliberately NOT created by a trigger on auth.users. That table is shared
-- with the other app in this project, and a trigger there would create FinSight
-- profiles for its users too. The app upserts a profile on first authenticated
-- request instead.
create table if not exists fs_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Filings: one row per ingested 10-K. Small table, and the source of truth for
-- the company/year aliases the query parser uses.
-- ---------------------------------------------------------------------------
create table if not exists fs_filings (
  id           uuid primary key default gen_random_uuid(),
  ticker       text not null,
  company      text not null,
  fiscal_year  text not null,
  filing_type  text not null default '10-K',
  source_url   text not null,
  accession    text,
  filing_date  date,
  chunk_count  integer not null default 0,
  is_ready     boolean not null default false,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (ticker, fiscal_year)
);

-- Cleaned filing text, kept separately from fs_filings so listing filings stays
-- cheap. Worth the storage: re-chunking with different settings then costs no
-- SEC download and no extra parse, which is exactly what tuning requires.
create table if not exists fs_filing_text (
  filing_id   uuid primary key references fs_filings (id) on delete cascade,
  content     text not null,
  char_count  integer not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Chunks: the retrieval corpus.
-- ---------------------------------------------------------------------------
-- `embedding` is nullable on purpose. Ingest inserts the text first and fills
-- the vectors in later batches, so a half-finished job leaves rows that are
-- visibly not ready rather than rows that are silently wrong. Search skips
-- rows where it is null.
create table if not exists fs_chunks (
  chunk_id     text primary key,
  filing_id    uuid not null references fs_filings (id) on delete cascade,
  content      text not null,
  ticker       text not null,
  company      text not null,
  fiscal_year  text not null,
  section      text not null,
  source_url   text not null,
  ordinal      integer not null,
  embedding    vector(768),
  fts          tsvector generated always as (to_tsvector('english', content)) stored,
  created_at   timestamptz not null default now()
);

-- HNSW rather than IVFFlat: it needs no training pass, which matters when the
-- table starts empty and grows one filing at a time.
create index if not exists fs_chunks_embedding_idx
  on fs_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists fs_chunks_fts_idx on fs_chunks using gin (fts);
create index if not exists fs_chunks_ticker_year_idx on fs_chunks (ticker, fiscal_year);
create index if not exists fs_chunks_filing_idx on fs_chunks (filing_id);
create index if not exists fs_chunks_pending_idx
  on fs_chunks (filing_id) where embedding is null;

-- ---------------------------------------------------------------------------
-- Ingest jobs: the state machine behind "add a company".
-- ---------------------------------------------------------------------------
-- Ingesting a filing is hundreds of embedding calls and cannot fit inside one
-- serverless request, so the work is sliced. This table IS the progress: each
-- step call reads it, does one batch, and writes back. A browser that closes
-- mid-run leaves a resumable job, not a corrupted one.
create table if not exists fs_ingest_jobs (
  id               uuid primary key default gen_random_uuid(),
  filing_id        uuid references fs_filings (id) on delete cascade,
  ticker           text not null,
  status           text not null default 'queued'
                     check (status in ('queued', 'fetching', 'chunking', 'embedding', 'ready', 'failed')),
  total_chunks     integer not null default 0,
  embedded_chunks  integer not null default 0,
  error            text,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists fs_ingest_jobs_status_idx on fs_ingest_jobs (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Conversations and messages.
-- ---------------------------------------------------------------------------
create table if not exists fs_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists fs_conversations_user_idx
  on fs_conversations (user_id, updated_at desc);

-- Retrieval diagnostics are stored next to the answer, not just logged. They
-- are what makes a bad answer explainable after the fact: which chunks were
-- used, how confident retrieval was, whether the gate fired, and whether the
-- answer came from the model or from the degraded extractive fallback.
create table if not exists fs_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references fs_conversations (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  citations        jsonb not null default '[]'::jsonb,
  top_cosine       real,
  gated            boolean not null default false,
  degraded         boolean not null default false,
  latency_ms       integer,
  created_at       timestamptz not null default now()
);

create index if not exists fs_messages_conversation_idx
  on fs_messages (conversation_id, created_at);

create table if not exists fs_feedback (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references fs_messages (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  rating      smallint not null check (rating in (-1, 1)),
  reason      text,
  created_at  timestamptz not null default now(),
  unique (message_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Embedding cache.
-- ---------------------------------------------------------------------------
-- The free Gemini tier allows 1,000 embed requests per day and one corpus is
-- roughly that size, so an accidental re-ingest can take the whole app offline
-- until the daily reset. Keying by content hash makes a repeat ingest free.
create table if not exists fs_embedding_cache (
  text_hash   text primary key,
  embedding   vector(768) not null,
  created_at  timestamptz not null default now()
);
