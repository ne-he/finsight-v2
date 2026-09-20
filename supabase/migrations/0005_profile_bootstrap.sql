-- Profile creation, with a first-account bootstrap.
--
-- The problem this solves: an administrator is needed to ingest the first
-- filing, but roles are deliberately not writable from the client, so a fresh
-- deployment would have no way to appoint one without opening the SQL editor.
--
-- So the very first account to sign up becomes the administrator. That is safe
-- here because the person deploying signs up before anyone else can reach the
-- URL, and it is the only moment the rule applies: once an admin exists, every
-- later account is an ordinary user.
--
-- Doing it in one function rather than in application code is what makes it
-- correct under concurrency. Two simultaneous first sign-ups reading "no admin
-- exists" would both become administrators; the lock makes that impossible.

create or replace function fs_ensure_profile(p_id uuid, p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from fs_profiles where id = p_id;
  if v_role is not null then
    return v_role;
  end if;

  lock table fs_profiles in exclusive mode;

  if exists (select 1 from fs_profiles where role = 'admin') then
    v_role := 'user';
  else
    v_role := 'admin';
  end if;

  insert into fs_profiles (id, email, role)
  values (p_id, p_email, v_role)
  on conflict (id) do update set email = excluded.email
  returning role into v_role;

  return v_role;
end;
$$;

-- Only the server may call this. It is SECURITY DEFINER, so a signed-in user
-- calling it with someone else's id would otherwise be creating profiles.
revoke execute on function fs_ensure_profile(uuid, text) from anon, authenticated;
