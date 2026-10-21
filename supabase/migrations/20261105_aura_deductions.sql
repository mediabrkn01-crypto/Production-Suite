-- ════════════════════════════════════════════════════════════════════════════
-- AURA POINTS — confidential DEDUCTIONS + founders hold no Aura. Run after 20261027
-- (20261028 + 20261029 recommended first). Nothing is deleted or rewritten. Safe to re-run.
--
--   kind 'deduction'   stored in the SAME table as awards, as NEGATIVE points
--                      (−10 / −20 / −50 / −100), reason required (existing check), never self
--                      (existing aura_no_self). Monthly net = SUM(points) of active rows.
--   confidentiality    the browser key may read awards only. Deduction rows are invisible to it
--                      (RLS below) — and therefore also to Realtime subscribers, which apply the
--                      same policy. They are served only by the `aura` edge function to the
--                      employee, their head, the HR manager and leadership.
--   founders           nobody can award to / deduct from leadership (System Role manager /
--                      founder / co_founder / managing_director / director, or a management
--                      account) — enforced here as well as in the function.
-- ════════════════════════════════════════════════════════════════════════════

-- 1 · allow the new kind, with fixed deduction sizes
alter table public.aura_point_transactions drop constraint if exists aura_point_transactions_kind_check;
alter table public.aura_point_transactions add constraint aura_point_transactions_kind_check
  check (kind in ('award', 'adjustment', 'deduction'));
alter table public.aura_point_transactions drop constraint if exists aura_deduct_points;
alter table public.aura_point_transactions add constraint aura_deduct_points
  check (kind <> 'deduction' or points in (-10, -20, -50, -100));

-- 2 · browser reads: awards / adjustments only — deductions are confidential
drop policy if exists aura_point_transactions_read on public.aura_point_transactions;
create policy aura_point_transactions_read on public.aura_point_transactions
  for select using (kind <> 'deduction');

-- 3 · leadership never holds Aura Points (DB guard, in addition to the edge function)
create or replace function public.aura_tx_recipient_guard() returns trigger
language plpgsql as $$
declare v record;
begin
  select system_role, account_type into v from public.hr_employees where id = new.recipient_employee_id;
  if lower(coalesce(v.system_role, '')) in ('manager', 'founder', 'co_founder', 'managing_director', 'director')
     or v.account_type in ('management', 'system') then
    raise exception 'Founders and leadership don''t hold Aura Points';
  end if;
  return new;
end $$;
drop trigger if exists trg_aura_tx_recipient_guard on public.aura_point_transactions;
create trigger trg_aura_tx_recipient_guard
  before insert on public.aura_point_transactions
  for each row execute function public.aura_tx_recipient_guard();

-- 4 · monthly leaderboard query (active rows of a month)
create index if not exists idx_aura_active_month on public.aura_point_transactions (created_at, recipient_employee_id) include (points, kind) where status = 'active';
