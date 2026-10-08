-- ════════════════════════════════════════════════════════════════════════════
-- Half-day leave: leave quantities must hold 0.5.
--
-- Bug (2026-10-08): submitting a Half Day failed with
--   invalid input syntax for type integer: "0.5"
-- because hr_leave_requests.consecutive_days was INTEGER while the form sent days (0.5).
-- Every other leave / balance / payroll quantity is already numeric:
--   hr_leave_requests.days, hr_leave_balances.allotted/used, hr_cl_buckets.original_amount/
--   remaining_amount, hr_sl_ledger.entitlement/used/expired, hr_payroll.paid_leave_days/
--   unpaid_leave_days/absent_days.
-- integer → numeric is lossless: existing values are unchanged. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_leave_requests
  alter column consecutive_days type numeric using consecutive_days::numeric;

-- Guard: a request quantity is a positive multiple of 0.5 (0.5, 1, 1.5, 2 …).
alter table public.hr_leave_requests drop constraint if exists hr_leave_requests_days_half_chk;
alter table public.hr_leave_requests add constraint hr_leave_requests_days_half_chk
  check (days is null or (days > 0 and days * 2 = floor(days * 2))) not valid;

-- Check
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'hr_leave_requests' and column_name in ('days', 'consecutive_days');
