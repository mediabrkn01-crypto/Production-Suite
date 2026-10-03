-- ════════════════════════════════════════════════════════════════════════════
-- HR load performance.
--
-- photo_sig: md5 of the stored employee photo, so the HR page can keep small cached
-- thumbnails per browser and only download a photo again when it actually changed.
-- (The full base64 photos were ~1.1 MB of the employee list and took ~15 s to load.)
-- Generated column → always in sync, nothing in the app writes it.
--
-- Indexes: only for lookups the portals really run on every page load / check:
--   hr_employees.portal_email   — login, access guard, SSO in every portal, own-profile lookups
--   hr_leave_requests.employee_id, hr_payroll(employee_id, month),
--   hr_salary_history.employee_id — employee-scoped reads (My Leave / payslips / profile)
-- hr_attendance (employee_id, att_date), hr_leave_balances (employee_id, leave_type),
-- attendance_logs (employee_email, log_date), hr_cl_buckets / hr_sl_ledger already have
-- matching unique indexes. The tables are small today; these keep the lookups flat as they grow.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_employees
  add column if not exists photo_sig text
  generated always as (case when photo_base64 is null or photo_base64 = '' then null else md5(photo_base64) end) stored;

create index if not exists idx_hr_employees_portal_email on public.hr_employees (portal_email);
create index if not exists idx_hr_leave_requests_employee on public.hr_leave_requests (employee_id, start_date);
create index if not exists idx_hr_payroll_employee_month on public.hr_payroll (employee_id, month);
create index if not exists idx_hr_salary_history_employee on public.hr_salary_history (employee_id, effective_date);
