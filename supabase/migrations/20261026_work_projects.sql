-- ════════════════════════════════════════════════════════════════════════════
-- MULTI-EMPLOYEE WORK PROJECTS (Media Suite → Work Assignment)
--
--   work_projects          the shared parent: title, shared brief, status (derived)
--   assignments            UNCHANGED as the per-person work row (every existing screen, the
--                          approval / rework / delivery flow and history keep working). New:
--                            project_id   → work_projects.id (NULL = legacy single assignment,
--                                           shown as "1 project + 1 assignment")
--                            deliverable  → what THIS person delivers ("Create poster")
--                          `type` stays the classification, `description` = individual
--                          instructions, `reference_file` = this person's own files.
--   work_reference_files   every reference file: assignment_id NULL = shared project file,
--                          assignment_id set = that person's own file. Soft-removed only.
--
--   Project status (trigger, never typed by hand):
--     not_started · in_progress · partially_completed · completed · cancelled
--     computed from the project's NON-cancelled assignments ("Completed" status = done).
--   Notifications (erp_notifications, one row per event, deduped):
--     "Video Editing completed for Vocabulary Reels Day 5."      — per assignment
--     "Vocabulary Reels Day 5 is fully completed."               — once, when the project completes
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.work_projects (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  shared_description  text,
  kind                text not null default 'multi_deliverable' check (kind in ('multi_deliverable', 'collaboration')),
  department          text not null default 'production',
  scope               text not null default 'media',
  status              text not null default 'not_started'
                      check (status in ('not_started', 'in_progress', 'partially_completed', 'completed', 'cancelled')),
  folder_url          text,
  created_by          text,
  created_by_email    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  cancelled_at        timestamptz
);
create index if not exists idx_work_projects_created on public.work_projects (created_at desc);

alter table public.assignments add column if not exists project_id  uuid references public.work_projects(id);
alter table public.assignments add column if not exists deliverable text;
create index if not exists idx_assignments_project on public.assignments (project_id) where project_id is not null;

create table if not exists public.work_reference_files (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.work_projects(id) on delete cascade,
  assignment_id  bigint references public.assignments(id) on delete cascade,
  file_name      text not null,
  file_url       text not null,
  file_size      bigint,
  mime_type      text,
  uploaded_by    text,
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_by     text
);
create index if not exists idx_work_ref_project on public.work_reference_files (project_id, assignment_id);

do $$ declare t text; begin
  foreach t in array array['work_projects', 'work_reference_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format('create policy %I on public.%I for all using (true) with check (true)', t || '_all', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ── Recipients for work notifications (assigner, department head, management) ─────────
create or replace function public.erp_work_recipients(p_department text, p_assigned_by text, p_created_by text, p_exclude_email text)
returns table (id uuid, email text) language sql stable security definer set search_path = public as $$
  select distinct on (lower(e.portal_email)) e.id, lower(e.portal_email)
  from public.hr_employees e
  where coalesce(e.portal_email, '') <> ''
    and coalesce(e.account_type, '') <> 'system'
    and coalesce(lower(e.employment_status), 'active') not in ('exited', 'inactive')
    and lower(e.portal_email) <> lower(coalesce(p_exclude_email, ''))
    and (
      lower(e.full_name) = lower(coalesce(p_assigned_by, ''))
      or lower(e.full_name) = lower(coalesce(p_created_by, ''))
      or lower(e.portal_email) = lower(coalesce(p_created_by, ''))
      or lower(coalesce(e.system_role, '')) in ('manager', 'founder', 'co_founder', 'managing_director', 'director')
      or coalesce(e.account_type, '') = 'management'
      or (p_department = 'production' and lower(coalesce(e.system_role, '')) = 'media_head')
      or (p_department = 'education' and (lower(coalesce(e.system_role, '')) = 'academic_head'
            or e.designation ~* '^(senior |junior )?(academic head|class coordinator|operations manager)$'))
      or (p_department = 'hr' and (lower(coalesce(e.system_role, '')) = 'hr_admin' or (e.division = 'hr' and e.designation ~* 'head|manager')))
      or (p_department = 'sales' and e.division = 'sales' and e.designation ~* 'head|manager')
    );
$$;

-- ── Per-assignment completion (replaces the 20261023 version; same dedupe key) ──────────
create or replace function public.erp_notify_work_completed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_emp record; v_has_out boolean; v_media boolean; v_who text; v_dep text; v_dept text;
  v_title text; v_msg text; v_at text; v_key text; v_project text;
begin
  if new.status is distinct from 'Completed' or old.status is not distinct from 'Completed' then
    return new;
  end if;
  v_has_out := coalesce(nullif(trim(new.asset_link::text), ''), '') <> '';
  v_dept    := coalesce(new.department::text, case when coalesce(new.scope::text, '') = 'org' then 'management' else 'production' end);
  v_media   := v_dept = 'production';
  v_who     := coalesce(nullif(new.final_submitted_by::text, ''), nullif(new.assigned_to::text, ''), 'An employee');
  v_dep     := case v_dept when 'production' then 'Media' when 'education' then 'Academic' when 'sales' then 'Sales'
                 when 'hr' then 'HR' when 'management' then 'Management' else 'Work' end;
  v_at      := coalesce(new.completed_at::text, new.submitted_at::text, now()::text);
  v_key     := 'work_completed:' || new.id::text || ':' || v_at;
  if new.project_id is not null then
    select title into v_project from public.work_projects where id = new.project_id;
  end if;
  if v_project is not null then
    v_title := coalesce(nullif(new.type, ''), 'Work') || ' completed';
    v_msg   := coalesce(nullif(new.type, ''), 'Work') || ' completed for ' || v_project || ' — by ' || v_who
               || coalesce(' (' || nullif(new.deliverable, '') || ')', '')
               || case when v_has_out then '. Output uploaded and ready for review.' else '.' end;
  else
    v_title := case when v_media and v_has_out then 'Video Ready for Review' else 'Work Completed' end;
    v_msg   := v_who || ' completed: “' || coalesce(new.topic, 'Task') || '”' ||
               case when v_has_out then '. Final output has been uploaded and is ready for review.' else '.' end;
  end if;
  for v_emp in select * from public.erp_work_recipients(v_dept, new.assigned_by, new.created_by, new.employee_email) loop
    insert into public.erp_notifications (recipient_email, recipient_employee_id, type, title, message, entity_type, entity_id, dedupe_key, link, metadata)
    values (v_emp.email, v_emp.id, case when v_has_out then 'work_output_uploaded' else 'work_completed' end, v_title, v_msg,
            'assignment', new.id::text, v_key, 'work:' || new.id::text,
            jsonb_build_object('employee', v_who, 'topic', new.topic, 'department', v_dep, 'has_output', v_has_out,
                               'completed_at', v_at, 'project_id', new.project_id, 'project', v_project, 'classification', new.type))
    on conflict (recipient_email, dedupe_key) do nothing;
  end loop;
  return new;
exception when others then
  raise warning 'erp_notify_work_completed: %', sqlerrm;
  return new;
end $$;

-- ── Project status from its assignments + "fully completed" notification ───────────────
create or replace function public.work_project_refresh(p_project uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_total int; v_live int; v_done int; v_started int; v_status text; v_old text; v_p record; v_emp record; v_first record;
begin
  if p_project is null then return; end if;
  select count(*),
         count(*) filter (where status <> 'cancelled'),
         count(*) filter (where status = 'Completed'),
         count(*) filter (where status in ('In Progress', 'Completed', 'Rework Required') or coalesce(progress, 0) > 0)
    into v_total, v_live, v_done, v_started
    from public.assignments where project_id = p_project;
  v_status := case
    when v_total = 0 then 'not_started'
    when v_live = 0 then 'cancelled'
    when v_done = v_live then 'completed'
    when v_done > 0 then 'partially_completed'
    when v_started > 0 then 'in_progress'
    else 'not_started' end;
  select * into v_p from public.work_projects where id = p_project;
  if not found then return; end if;
  v_old := v_p.status;
  if v_old is distinct from v_status then
    update public.work_projects set status = v_status, updated_at = now(),
      completed_at = case when v_status = 'completed' then coalesce(completed_at, now()) else null end,
      cancelled_at = case when v_status = 'cancelled' then coalesce(cancelled_at, now()) else null end
    where id = p_project;
    if v_status = 'completed' then
      select assigned_by, created_by, department, scope into v_first from public.assignments where project_id = p_project order by id limit 1;
      for v_emp in select * from public.erp_work_recipients(coalesce(v_first.department, case when v_first.scope = 'org' then 'management' else 'production' end), v_first.assigned_by, v_first.created_by, null) loop
        insert into public.erp_notifications (recipient_email, recipient_employee_id, type, title, message, entity_type, entity_id, dedupe_key, link, metadata)
        values (v_emp.email, v_emp.id, 'work_completed', 'Project completed', v_p.title || ' is fully completed (' || v_done || ' of ' || v_live || ' assignments).',
                'work_project', p_project::text, 'project_completed:' || p_project::text,
                'workproject:' || p_project::text, jsonb_build_object('project', v_p.title, 'assignments', v_live))
        on conflict (recipient_email, dedupe_key) do nothing;
      end loop;
    end if;
  end if;
end $$;

create or replace function public.trg_work_project_refresh() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    if tg_op = 'UPDATE' and old.project_id is distinct from new.project_id then perform public.work_project_refresh(old.project_id); end if;
    if new.project_id is not null then perform public.work_project_refresh(new.project_id); end if;
  exception when others then raise warning 'work_project_refresh: %', sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists trg_assignments_project_status on public.assignments;
create trigger trg_assignments_project_status
  after insert or update of status, project_id, progress on public.assignments
  for each row execute function public.trg_work_project_refresh();
