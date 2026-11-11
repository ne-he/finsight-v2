-- Guest mode quota.
--
-- Guests have no auth.users row, so they cannot share fs_usage (its user_id is a
-- foreign key into auth.users). They get their own table, keyed by an opaque
-- visitor id: an HMAC of the day and the caller's IP, computed in the app with a
-- server-side key. The raw address is never stored, and because the day is part
-- of the hash the same visitor cannot be linked from one day to the next.
--
-- The row with visitor = '*' holds the total for all guests that day.
--
-- Guest questions also count against fs_usage_global, so guests can never take
-- more of the shared Gemini quota than the global cap allows signed-in users.

create table if not exists fs_guest_usage (
  day      date not null,
  visitor  text not null,
  count    integer not null default 0,
  primary key (day, visitor)
);

alter table fs_guest_usage enable row level security;
-- No client policy: only the service role touches this table.

create or replace function fs_bump_guest_usage(
  p_visitor        text,
  p_visitor_limit  int,
  p_guest_limit    int,
  p_global_limit   int
)
returns table (allowed boolean, reason text, used int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_global  int;
  v_guests  int;
  v_visitor int;
begin
  if p_visitor is null or p_visitor = '*' or length(p_visitor) < 16 then
    raise exception 'invalid visitor id';
  end if;

  insert into fs_usage_global (day, count)
  values (current_date, 1)
  on conflict (day) do update set count = fs_usage_global.count + 1
  returning fs_usage_global.count into v_global;

  if v_global > p_global_limit then
    return query select false, 'global'::text, v_global;
    return;
  end if;

  insert into fs_guest_usage (day, visitor, count)
  values (current_date, '*', 1)
  on conflict (day, visitor) do update set count = fs_guest_usage.count + 1
  returning fs_guest_usage.count into v_guests;

  if v_guests > p_guest_limit then
    return query select false, 'guests'::text, v_guests;
    return;
  end if;

  insert into fs_guest_usage (day, visitor, count)
  values (current_date, p_visitor, 1)
  on conflict (day, visitor) do update set count = fs_guest_usage.count + 1
  returning fs_guest_usage.count into v_visitor;

  if v_visitor > p_visitor_limit then
    return query select false, 'visitor'::text, v_visitor;
    return;
  end if;

  return query select true, null::text, v_visitor;
end;
$$;

revoke execute on function fs_bump_guest_usage(text, int, int, int) from public, anon, authenticated;

-- Old guest rows are useless after their day ends. Keep a week for debugging.
create or replace function fs_prune_guest_usage()
returns void
language sql
security definer
set search_path = public
as $$
  delete from fs_guest_usage where day < current_date - 7;
$$;

revoke execute on function fs_prune_guest_usage() from public, anon, authenticated;
