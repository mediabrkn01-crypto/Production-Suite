-- ════════════════════════════════════════════════════════════════════════════
-- Department scope for people responsible for MORE than their own department
-- (e.g. an Operations Manager over Academics + Sales).
--
--   hr_employees.managed_divisions   extra hr_divisions codes, set by HR on the employee
--                                    ("Also responsible for"). Own division always counts.
--
-- Used by the `aura` edge function: head-level access → own department; with extra
-- departments (or the Operations Manager designation) → own + these. Managers stay
-- organisation-wide. Unknown codes are rejected. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.hr_employees add column if not exists managed_divisions text[] not null default '{}';

create or replace function public.hr_employees_check_managed_divisions() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from unnest(coalesce(new.managed_divisions, '{}')) d
             where not exists (select 1 from public.hr_divisions h where h.code = d)) then
    raise exception 'Unknown department in managed_divisions';
  end if;
  return new;
end $$;
drop trigger if exists trg_hr_employees_managed_divisions on public.hr_employees;
create trigger trg_hr_employees_managed_divisions
  before insert or update of managed_divisions on public.hr_employees
  for each row execute function public.hr_employees_check_managed_divisions();
