-- ════════════════════════════════════════════════════════════════════════════
-- Payroll → Payslip as two HR-controlled steps.
--
-- hr_payroll stays the single financial record (one row per employee per SALARY month).
-- The payslip is the employee-facing document built from that same row — no second copy of
-- salary figures, so payroll and payslip can never disagree. Its stage lives on the row:
--
--   payslip_status  not_generated → draft → ready → sent
--     not_generated  payroll calculated, no payslip yet (HR still verifying)
--     draft          HR clicked Generate Payslip; HR only
--     ready          HR verified it; can be sent
--     sent           delivered — the ONLY state an employee can see
--
-- `published` (what the employee portal already filters on) is now derived from the status
-- by trigger, so an unfinished payslip can't become visible by any code path.
-- `month` = salary month (YYYY-MM); processing dates are the *_at audit columns.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_payroll
  add column if not exists payslip_status text not null default 'not_generated',
  add column if not exists payslip_note text,
  add column if not exists payroll_generated_by text,
  add column if not exists payroll_generated_at timestamptz,
  add column if not exists payroll_updated_by text,
  add column if not exists payroll_updated_at timestamptz,
  add column if not exists payslip_generated_by text,
  add column if not exists payslip_generated_at timestamptz,
  add column if not exists payslip_edited_by text,
  add column if not exists payslip_edited_at timestamptz,
  add column if not exists payslip_sent_by text,
  add column if not exists payslip_sent_at timestamptz;

do $$ begin
  alter table public.hr_payroll add constraint hr_payroll_payslip_status_chk
    check (payslip_status in ('not_generated','draft','ready','sent'));
exception when duplicate_object then null; end $$;

-- Existing rows: anything already published was sent; the rest were auto-created drafts.
update public.hr_payroll set payslip_status = 'sent', payslip_sent_at = coalesce(payslip_sent_at, created_at),
       payslip_generated_at = coalesce(payslip_generated_at, created_at)
 where published is true and payslip_status = 'not_generated';
update public.hr_payroll set payroll_generated_at = created_at where payroll_generated_at is null;

-- One payroll — and therefore one payslip — per employee per salary month.
create unique index if not exists uq_hr_payroll_employee_month on public.hr_payroll (employee_id, month);

create or replace function public.trg_hr_payroll_payslip_visibility()
returns trigger language plpgsql as $$
begin
  new.published := (new.payslip_status = 'sent');
  return new;
end; $$;
drop trigger if exists hr_payroll_payslip_visibility on public.hr_payroll;
create trigger hr_payroll_payslip_visibility
  before insert or update on public.hr_payroll
  for each row execute function public.trg_hr_payroll_payslip_visibility();
