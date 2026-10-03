-- ════════════════════════════════════════════════════════════════════════════
-- Employee status → portal access, one rule for every portal.
--
--  * hr_employees.employment_status is the primary rule: an inactive or exited employee
--    can never have portal_access_enabled = true (trigger below forces it off, also when
--    HR tries to switch it back on without reactivating the employee first).
--  * Reactivation (→ active) does NOT silently re-enable sign-in: HR restores it.
--  * portal_access_state(email) is the single access answer every portal asks — at login,
--    on page load, and periodically during an open session (access-guard.js).
--  * Records are never deleted: payroll / attendance / leave / documents stay intact.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.trg_hr_employees_access_sync()
returns trigger language plpgsql as $$
begin
  if coalesce(new.account_type, 'employee') <> 'system'
     and lower(coalesce(new.employment_status, 'active')) in ('inactive', 'exited') then
    new.portal_access_enabled := false;
  end if;
  return new;
end; $$;

drop trigger if exists hr_employees_access_sync on public.hr_employees;
create trigger hr_employees_access_sync
  before insert or update of employment_status, portal_access_enabled, account_type on public.hr_employees
  for each row execute function public.trg_hr_employees_access_sync();

create or replace function public.portal_access_state(p_email text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e hr_employees%rowtype; st text;
begin
  if coalesce(trim(p_email), '') = '' then return jsonb_build_object('allowed', true, 'reason', 'no_identity'); end if;
  -- One login can have several rows (e.g. a re-hire): system first, then an active row.
  select * into e from hr_employees
   where lower(trim(portal_email)) = lower(trim(p_email))
   order by (account_type = 'system') desc,
            (lower(coalesce(employment_status, 'active')) = 'active') desc,
            (portal_access_enabled is not false) desc
   limit 1;
  if not found then return jsonb_build_object('allowed', true, 'reason', 'no_hr_record'); end if;
  if e.account_type = 'system' then return jsonb_build_object('allowed', true, 'reason', 'system'); end if;
  st := lower(coalesce(e.employment_status, 'active'));
  if st = 'exited' then
    return jsonb_build_object('allowed', false, 'reason', 'exited', 'status', st,
      'message', 'Your employment has ended, so portal access is closed. Contact HR if this is a mistake.');
  end if;
  if st = 'inactive' then
    return jsonb_build_object('allowed', false, 'reason', 'inactive', 'status', st,
      'message', 'Your employee account is inactive, so sign-in is disabled. Contact HR.');
  end if;
  if e.portal_access_enabled is false then
    return jsonb_build_object('allowed', false, 'reason', 'disabled', 'status', st,
      'message', 'HR has disabled your portal access. Contact HR for assistance.');
  end if;
  return jsonb_build_object('allowed', true, 'reason', 'active', 'status', st);
end; $$;
grant execute on function public.portal_access_state(text) to anon, authenticated;

-- One-time correction: inactive / exited employees that still had sign-in switched on.
update public.hr_employees
   set portal_access_enabled = false
 where coalesce(account_type, 'employee') <> 'system'
   and lower(coalesce(employment_status, 'active')) in ('inactive', 'exited')
   and portal_access_enabled is distinct from false;
