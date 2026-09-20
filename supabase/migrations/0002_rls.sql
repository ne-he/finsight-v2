-- Row Level Security.
--
-- The threat this closes: the browser holds the anon key, so anyone can call
-- the Supabase REST API directly with it. Without RLS, one visitor could read
-- every other visitor's conversation. Policies are enforced by Postgres, not by
-- the app, so they hold even if an API route forgets a check.
--
-- Writes to the corpus go through the service role key, which bypasses RLS and
-- never leaves the server.

alter table fs_profiles       enable row level security;
alter table fs_filings        enable row level security;
alter table fs_filing_text    enable row level security;
alter table fs_chunks         enable row level security;
alter table fs_ingest_jobs    enable row level security;
alter table fs_conversations  enable row level security;
alter table fs_messages       enable row level security;
alter table fs_feedback       enable row level security;
alter table fs_embedding_cache enable row level security;

-- Helper: is the caller an admin? SECURITY DEFINER so the policy can read
-- fs_profiles without recursing into that table's own policies.
create or replace function fs_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from fs_profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- --------------------------- profiles --------------------------------------
drop policy if exists fs_profiles_select_own on fs_profiles;
create policy fs_profiles_select_own on fs_profiles
  for select using (id = auth.uid() or fs_is_admin());

-- Role is deliberately NOT writable from the client. A user who could update
-- their own row would simply set role = 'admin'. Promotion happens with the
-- service role key or by hand in the SQL editor.

-- --------------------------- corpus ----------------------------------------
-- Filings and chunks are public reference data derived from public SEC
-- documents, so any authenticated user may read them.
drop policy if exists fs_filings_select on fs_filings;
create policy fs_filings_select on fs_filings
  for select using (auth.role() = 'authenticated');

drop policy if exists fs_chunks_select on fs_chunks;
create policy fs_chunks_select on fs_chunks
  for select using (auth.role() = 'authenticated');

-- --------------------------- ingest jobs -----------------------------------
drop policy if exists fs_ingest_jobs_select_admin on fs_ingest_jobs;
create policy fs_ingest_jobs_select_admin on fs_ingest_jobs
  for select using (fs_is_admin());

-- --------------------------- conversations ---------------------------------
drop policy if exists fs_conversations_own on fs_conversations;
create policy fs_conversations_own on fs_conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists fs_messages_own on fs_messages;
create policy fs_messages_own on fs_messages
  for all
  using (
    exists (
      select 1 from fs_conversations c
      where c.id = fs_messages.conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from fs_conversations c
      where c.id = fs_messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- --------------------------- feedback --------------------------------------
-- A user manages their own rating; an admin reads all of them, which is the
-- point of collecting feedback in the first place.
drop policy if exists fs_feedback_own on fs_feedback;
create policy fs_feedback_own on fs_feedback
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists fs_feedback_select_admin on fs_feedback;
create policy fs_feedback_select_admin on fs_feedback
  for select using (fs_is_admin());

-- --------------------------- embedding cache -------------------------------
-- Server-side only. No client policy is created, so RLS denies every request
-- made with the anon key.
