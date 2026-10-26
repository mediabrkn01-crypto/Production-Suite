-- ============================================================================
-- Monthly Work Archive → organisation-wide (all departments), scoped by ERP role.
--
-- An archive is now one per (month, scope):
--   scope_key 'org'           organisation-wide — leadership (Founder / Co-Founder / manager tier)
--   scope_key 'dept:<code>'   one department — its Department Head / Operations Manager
-- The existing archives keep scope_key 'org' (default) so they are reused, never duplicated.
-- Items record their department so department / self views read them without re-deriving.
-- Additive only: nothing is dropped except the old month-only unique constraint, replaced by
-- (month, scope_key).
-- ============================================================================
alter table public.work_archives      add column if not exists scope_key text not null default 'org';
alter table public.work_archives      drop constraint if exists work_archives_month_key;
create unique index if not exists uq_work_archives_month_scope on public.work_archives (month, scope_key);
alter table public.work_archives      drop constraint if exists work_archives_scope_key_check;
alter table public.work_archives      add constraint work_archives_scope_key_check check (scope_key = 'org' or scope_key ~ '^dept:[a-z_]+$');

alter table public.work_archive_items add column if not exists department text;
