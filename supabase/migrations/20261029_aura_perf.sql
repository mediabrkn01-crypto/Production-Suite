-- ════════════════════════════════════════════════════════════════════════════
-- Aura Points load performance (indexes only — no data or permission changes).
--
--   The aura edge function's `scope` action now returns every rewardable employee with
--   their current Aura in one query:
--     select recipient_employee_id, points, created_at from aura_point_transactions
--     where status = 'active' and recipient_employee_id in (...)
--   → covering partial index below (index-only scan, reversed rows skipped).
--   Dashboards / rankings filter active rows by date → (created_at) partial index.
--   Department scope filters hr_employees by division → idx_hr_employees_division.
--   (recipient_employee_id, created_at desc) and (created_at desc) already exist from
--   20261027; hr_employees.portal_email from 20261005. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════
create index if not exists idx_aura_active_recipient
  on public.aura_point_transactions (recipient_employee_id) include (points, created_at)
  where status = 'active';
create index if not exists idx_aura_active_created
  on public.aura_point_transactions (created_at) include (recipient_employee_id, points)
  where status = 'active';
create index if not exists idx_hr_employees_division on public.hr_employees (division);
