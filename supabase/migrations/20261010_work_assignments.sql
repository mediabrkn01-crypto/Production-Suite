-- ════════════════════════════════════════════════════════════════════════════
-- Central Work Assignment — one task table for the whole organisation.
--
-- The Media "assignments" table becomes the single assignment engine (work-tasks.js):
--   scope        'media' = Media pipeline task (existing behaviour, default for every
--                existing row); 'org' = task for any other department (Academics, Sales,
--                HR, Management …) — kept out of the Media pipeline screens.
--   department   assignee's HR division at assign time (production / education / sales /
--                hr / accounts / other) — filters and department-head permissions.
--   employee_id  hr_employees.id of the assignee (name + employee_email stay as before).
--   history      append-only audit trail: created / edited / reassigned / status changes /
--                progress updates, each {at, by, action, …}.
--   progress, started_at, completed_at, created_at, updated_at, reference_link.
-- Existing Media rows are untouched apart from scope='media' / department='production'.
-- The old Academics trainer_tasks table (empty) is no longer used. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.assignments
  add column if not exists scope          text not null default 'media',
  add column if not exists department     text,
  add column if not exists employee_id    uuid,
  add column if not exists created_by     text,
  add column if not exists created_at     timestamptz default now(),
  add column if not exists updated_at     timestamptz default now(),
  add column if not exists started_at     timestamptz,
  add column if not exists completed_at   timestamptz,
  add column if not exists progress       integer not null default 0,
  add column if not exists reference_link text,
  add column if not exists history        jsonb not null default '[]'::jsonb;

-- Existing rows are Media work.
update public.assignments set department = 'production' where department is null;
update public.assignments a set employee_id = e.id
  from public.hr_employees e
 where a.employee_id is null and lower(e.portal_email) = lower(a.employee_email);
update public.assignments
   set created_at = coalesce(created_at, (assigned_date || 'T09:00:00+05:30')::timestamptz)
 where assigned_date ~ '^\d{4}-\d{2}-\d{2}$' and created_at is not null and created_at > now() - interval '1 minute';

alter table public.assignments drop constraint if exists assignments_scope_chk;
alter table public.assignments add constraint assignments_scope_chk check (scope in ('media', 'org'));
alter table public.assignments drop constraint if exists assignments_progress_chk;
alter table public.assignments add constraint assignments_progress_chk check (progress between 0 and 100);

create index if not exists idx_assignments_email      on public.assignments (lower(employee_email));
create index if not exists idx_assignments_dept_state on public.assignments (department, status);
create index if not exists idx_assignments_scope      on public.assignments (scope);

-- updated_at on every change
create or replace function public.trg_assignments_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists assignments_touch on public.assignments;
create trigger assignments_touch before update on public.assignments
  for each row execute function public.trg_assignments_touch();

-- Realtime: assignments is already in supabase_realtime; make sure (no-op if present).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignments') then
    execute 'alter publication supabase_realtime add table public.assignments';
  end if;
end $$;
