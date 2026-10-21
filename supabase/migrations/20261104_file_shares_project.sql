-- ════════════════════════════════════════════════════════════════════════════
-- FILE SHARING — allow sending a whole multi-person PROJECT (Approved Works groups the
-- assignments of one work_projects row into one card; "Send Entire Project / Select Files").
--   erp_file_shares.source_type  + 'project'   (source_id = work_projects.id)
-- Each shared file keeps {name, url, kind, group, assignment_id} → which deliverable /
-- person it came from. Still pointers only — nothing is copied. Run after 20261103.
-- (Until this runs, the share function records project sends as source_type 'assignment'
--  with source_id 'project:<id>' — they work the same.) Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.erp_file_shares drop constraint if exists erp_file_shares_source_type_check;
alter table public.erp_file_shares add constraint erp_file_shares_source_type_check
  check (source_type in ('assignment', 'project', 'forward', 'upload'));
