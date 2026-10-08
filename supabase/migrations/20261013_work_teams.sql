-- ════════════════════════════════════════════════════════════════════════════
-- Team / collaborative Work Assignment — ONE shared task, MANY employees.
--
--   assignments.assignment_type  'individual' (default — every existing row) | 'team'
--   assignments.team_lead_id     optional hr_employees.id responsible for final submission
--   assignments.final_submitted_by  who submitted the shared final output
--   assignment_members           many-to-many: one row per team member (never a CSV of ids).
--                                Removal is a soft delete (removed_at) so history, comments
--                                and files stay. contribution_status is each member's own
--                                progress, separate from the task's one shared status.
--   assignment_activity          light shared activity: comments + team output files.
--
-- A team task keeps a "primary" member in assignments.assigned_to / employee_email (the team
-- lead, else the first member) so every existing screen and count keeps working; the
-- organisation counts it ONCE. Existing individual tasks are untouched. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.assignments
  add column if not exists assignment_type    text not null default 'individual',
  add column if not exists team_lead_id       uuid,
  add column if not exists final_submitted_by text;
alter table public.assignments drop constraint if exists assignments_type_chk;
alter table public.assignments add constraint assignments_type_chk check (assignment_type in ('individual', 'team'));

create table if not exists public.assignment_members (
  id                  bigserial primary key,
  assignment_id       bigint not null references public.assignments(id) on delete cascade,
  employee_id         uuid,
  employee_email      text not null,
  employee_name       text,
  department          text,
  member_role         text not null default 'member' check (member_role in ('member', 'lead')),
  contribution_status text not null default 'not_started' check (contribution_status in ('not_started', 'in_progress', 'done')),
  joined_at           timestamptz not null default now(),
  added_by            text,
  removed_at          timestamptz,
  removed_by          text
);
create unique index if not exists uq_assignment_member_active
  on public.assignment_members (assignment_id, lower(employee_email)) where removed_at is null;
create index if not exists idx_assignment_members_email on public.assignment_members (lower(employee_email));
create index if not exists idx_assignment_members_task  on public.assignment_members (assignment_id);

create table if not exists public.assignment_activity (
  id             bigserial primary key,
  assignment_id  bigint not null references public.assignments(id) on delete cascade,
  author_email   text,
  author_name    text,
  kind           text not null default 'comment' check (kind in ('comment', 'file', 'contribution')),
  body           text,
  file_name      text,
  file_url       text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_assignment_activity_task on public.assignment_activity (assignment_id, created_at);

-- Same access model as public.assignments today (ERP portals use the anon key).
alter table public.assignment_members  enable row level security;
alter table public.assignment_activity enable row level security;
drop policy if exists assignment_members_all  on public.assignment_members;
drop policy if exists assignment_activity_all on public.assignment_activity;
create policy assignment_members_all  on public.assignment_members  for all using (true) with check (true);
create policy assignment_activity_all on public.assignment_activity for all using (true) with check (true);

-- Realtime (be-live.js) for members + activity.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignment_members') then
    execute 'alter publication supabase_realtime add table public.assignment_members';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignment_activity') then
    execute 'alter publication supabase_realtime add table public.assignment_activity';
  end if;
end $$;
