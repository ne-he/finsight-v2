-- Daily usage cap.
--
-- Why this lives in the database rather than in the API route: a serverless
-- function may be replaced between any two requests, so a counter held in
-- process memory silently resets and the cap leaks. The free Gemini tier is
-- small enough that a single visitor in a loop can take the app offline for the
-- rest of the day, so the counter has to survive.
--
-- Keyed by user id, not by IP. Every caller is signed in, so there is no need
-- to store or hash a visitor's address.

create table if not exists fs_usage (
  day       date not null,
  user_id   uuid not null references auth.users (id) on delete cascade,
  count     integer not null default 0,
  primary key (day, user_id)
);

alter table fs_usage enable row level security;
-- No client policy: only the service role touches this table.

create table if not exists fs_usage_global (
  day    date primary key,
  count  integer not null default 0
);

alter table fs_usage_global enable row level security;

-- Atomically record one question and report whether it was allowed.
--
-- The increment and the check happen in a single statement so two concurrent
-- requests cannot both read "one slot left" and both take it.
create or replace function fs_bump_usage(
  p_user         uuid,
  p_user_limit   int,
  p_global_limit int
)
returns table (allowed boolean, reason text, used int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_count   int;
  v_global_count int;
begin
  insert into fs_usage_global (day, count)
  values (current_date, 1)
  on conflict (day) do update set count = fs_usage_global.count + 1
  returning fs_usage_global.count into v_global_count;

  if v_global_count > p_global_limit then
    return query select false, 'global'::text, v_global_count;
    return;
  end if;

  insert into fs_usage (day, user_id, count)
  values (current_date, p_user, 1)
  on conflict (day, user_id) do update set count = fs_usage.count + 1
  returning fs_usage.count into v_user_count;

  if v_user_count > p_user_limit then
    return query select false, 'user'::text, v_user_count;
    return;
  end if;

  return query select true, null::text, v_user_count;
end;
$$;

revoke execute on function fs_bump_usage(uuid, int, int) from anon, authenticated;
