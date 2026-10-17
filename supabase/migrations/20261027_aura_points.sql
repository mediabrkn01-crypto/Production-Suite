-- ════════════════════════════════════════════════════════════════════════════
-- AURA POINTS — employee recognition (NOT pay: never read by payroll, leave, attendance
-- or performance code).
--
--   aura_point_transactions   one row per award / adjustment. Never edited or deleted:
--                             a cancelled award becomes status 'reversed' (who/when/why kept).
--                             An employee's Aura total = SUM(points) of status 'active' rows.
--   best_employee_selections  management's final Best Employee pick for a period (with the
--                             Aura Points that period had at selection time). A new pick for
--                             the same period supersedes, never deletes, the previous one.
--
-- WRITES ONLY THROUGH THE `aura` EDGE FUNCTION (service role), which re-resolves the caller
-- from their ERP sign-in and enforces the hierarchy (Manager org-wide ≤100; Operational
-- Manager / Head own department ≤50; never self). The browser key can READ these tables
-- but has no insert/update/delete policy, so a manipulated page cannot write points.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.aura_point_transactions (
  id                      uuid primary key default gen_random_uuid(),
  recipient_employee_id   uuid not null references public.hr_employees(id),
  recipient_name          text,
  recipient_department    text,                 -- hr_employees.division code at award time
  awarded_by_employee_id  uuid not null references public.hr_employees(id),
  awarded_by_name         text,
  awarder_role_snapshot   text not null,        -- manager | operational_manager | head | adjustment …
  kind                    text not null default 'award' check (kind in ('award', 'adjustment')),
  points                  int  not null,
  reason                  text not null check (length(trim(reason)) > 0),
  note                    text,
  status                  text not null default 'active' check (status in ('active', 'reversed')),
  idempotency_key         text,
  reversed_by             text,
  reversed_at             timestamptz,
  reversal_reason         text,
  created_at              timestamptz not null default now(),
  constraint aura_award_points check (kind <> 'award' or points in (10, 20, 50, 100)),
  constraint aura_adjust_points check (kind <> 'adjustment' or points <> 0),
  constraint aura_no_self check (recipient_employee_id <> awarded_by_employee_id)
);
create unique index if not exists uq_aura_idem on public.aura_point_transactions (awarded_by_employee_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_aura_recipient on public.aura_point_transactions (recipient_employee_id, created_at desc);
create index if not exists idx_aura_created on public.aura_point_transactions (created_at desc);

create table if not exists public.best_employee_selections (
  id                          uuid primary key default gen_random_uuid(),
  employee_id                 uuid not null references public.hr_employees(id),
  employee_name               text,
  department                  text,
  period_start                date not null,
  period_end                  date not null,
  period_label                text,
  aura_points_during_period   int not null default 0,
  selected_by_employee_id     uuid references public.hr_employees(id),
  selected_by_name            text,
  selected_at                 timestamptz not null default now(),
  notes                       text,
  status                      text not null default 'active' check (status in ('active', 'superseded')),
  check (period_end >= period_start)
);
create index if not exists idx_best_emp_period on public.best_employee_selections (period_start, period_end, status);

do $$ declare t text; begin
  foreach t in array array['aura_point_transactions', 'best_employee_selections'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (true)', t || '_read', t);   -- read-only for the browser
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
