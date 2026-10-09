-- ════════════════════════════════════════════════════════════════════════════
-- Payroll: Incentive as its own earnings component (separate from Bonus).
--
--   Gross = basic + allowances + overtime + bonuses + incentive_amount
--   Net   = Gross − (leave_deduction + deductions + advances)
--
-- Entered by HR (mainly Sales). Existing payroll rows get 0, so old payrolls and
-- payslips are unchanged. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_payroll
  add column if not exists incentive_amount numeric not null default 0;

do $$ begin
  alter table public.hr_payroll add constraint hr_payroll_incentive_nonneg_chk check (incentive_amount >= 0);
exception when duplicate_object then null; end $$;

comment on column public.hr_payroll.incentive_amount is
  'Incentive earnings (₹), entered by HR. Part of gross; kept separate from bonuses.';

-- Check
select count(*) filter (where incentive_amount <> 0) as rows_with_incentive, count(*) as payroll_rows from public.hr_payroll;
