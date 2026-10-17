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

-- ── Aura audit: the awarder's department scope at award time ─────────────────────────
-- ('*' = organisation-wide). Together with awarder_role_snapshot this records exactly
-- which authority the award was given under.
alter table public.aura_point_transactions add column if not exists awarder_scope text[];

-- ── Immutable history ─────────────────────────────────────────────────────────────────
-- An award row can never be deleted, and the only change ever allowed is the one-time
-- reversal (status active → reversed + who/when/why). Points, people, reason, note, scope
-- and timestamps are frozen — even for the service role.
create or replace function public.aura_tx_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Aura history is permanent — reverse the award instead of deleting it';
  end if;
  if old.status = 'reversed'
     or new.status is distinct from 'reversed'
     or (new.id, new.recipient_employee_id, new.recipient_name, new.recipient_department, new.awarded_by_employee_id,
         new.awarded_by_name, new.awarder_role_snapshot, new.awarder_scope, new.kind, new.points, new.reason, new.note,
         new.idempotency_key, new.created_at)
        is distinct from
        (old.id, old.recipient_employee_id, old.recipient_name, old.recipient_department, old.awarded_by_employee_id,
         old.awarded_by_name, old.awarder_role_snapshot, old.awarder_scope, old.kind, old.points, old.reason, old.note,
         old.idempotency_key, old.created_at) then
    raise exception 'Aura history is permanent — only a one-time reversal is allowed';
  end if;
  return new;
end $$;
drop trigger if exists trg_aura_tx_immutable on public.aura_point_transactions;
create trigger trg_aura_tx_immutable
  before update or delete on public.aura_point_transactions
  for each row execute function public.aura_tx_immutable();
