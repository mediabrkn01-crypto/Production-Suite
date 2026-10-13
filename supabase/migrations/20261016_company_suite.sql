-- ════════════════════════════════════════════════════════════════════════════
-- HR → Company Suite: organisation-wide VIEW of Media / Academics / Sales from inside HR.
--
-- Permission: hr_employees.access_company_suite (same family as access_payroll,
-- access_documents …, set by HR in Edit Employee → Login Access). It grants VIEW only:
-- the department pages open in a view-only mode in which their database writes are
-- blocked, so no batch / class / student / production task can be changed from there.
-- Editing stays with each department's own page and that person's normal access.
--
-- Initial grant: active HR-division employees (HR runs this feature). Editable per person.
-- hr_access_audit: one row when someone opens a department in Company Suite.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_employees
  add column if not exists access_company_suite boolean not null default false;

comment on column public.hr_employees.access_company_suite is
  'HR Company Suite: view-only access to every department page from inside HR Management.';

-- one-time initial grant (only rows never set before)
update public.hr_employees
   set access_company_suite = true
 where lower(coalesce(division, '')) = 'hr'
   and lower(coalesce(employment_status, 'active')) = 'active'
   and coalesce(account_type, 'employee') <> 'system'
   and access_company_suite = false;

create table if not exists public.hr_access_audit (
  id uuid primary key default gen_random_uuid(),
  viewer_email text,
  viewer_name text,
  area text not null,               -- e.g. 'company_suite:academics'
  viewed_at timestamptz not null default now()
);
create index if not exists idx_hr_access_audit_viewed on public.hr_access_audit (viewed_at desc);

alter table public.hr_access_audit enable row level security;
do $$ begin
  create policy "hr_access_audit_all" on public.hr_access_audit for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Check
select count(*) filter (where access_company_suite) as company_suite_users from public.hr_employees;
