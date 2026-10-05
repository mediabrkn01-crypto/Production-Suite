-- ════════════════════════════════════════════════════════════════════════════
-- Live data everywhere (be-live.js): add every table the portals listen to into the
-- supabase_realtime publication. Before this, only a few tables were published, so the
-- existing listeners for leave, HR attendance, payroll, employees, clock-in logs, tasks,
-- payments, trainers etc. never received anything and employees had to refresh.
--
-- Idempotent: tables already in the publication are skipped; missing tables are skipped too.
-- Realtime respects RLS, so this exposes nothing beyond what the same login can already read.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    -- Media / Production
    'user_roster','assignments','system_logs','attendance_logs','work_submission_files',
    -- HR + employee self-service
    'hr_employees','hr_leave_requests','hr_attendance','hr_payroll','hr_leave_balances',
    'hr_cl_buckets','hr_sl_ledger','hr_holidays','hr_official_events','hr_celebration_events',
    'hr_employee_documents','hr_salary_history','hr_job_openings','hr_applicants','hr_company_settings',
    'hr_announcements','hr_announcement_reads','hr_announcement_reactions','hr_announcement_replies',
    -- Academics
    'batches','attendance','students','payments','payment_entries','trainer_availability',
    'trainers','trainer_tasks','courses','trainer_session_earnings',
    -- Sales
    'leads','follow_ups','tasks','crm_leads'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t)
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Check: every listed table should now appear here.
-- select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
