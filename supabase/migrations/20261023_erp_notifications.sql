-- ════════════════════════════════════════════════════════════════════════════
-- ONE shared, database-backed notification store for every portal (HR, Academic, Media,
-- Sales, Manager). Until now notifications only lived in each browser's localStorage, so the
-- Manager bell had nothing to show, nothing survived a device change and nothing was live.
--
--   erp_notifications   one row per LOGICAL event per recipient (dedupe_key is unique), so a
--                       repeating reminder / a re-saved record never creates duplicates.
--     type              attendance_pending | attendance_completed | work_completed |
--                       work_output_uploaded
--     read_at           opened by the recipient
--     resolved_at       the underlying issue is gone (e.g. attendance marked)
--     snooze_until      "Remind me later" — server time, so it survives refresh / devices
--
--   trg_assignments_work_completed  — a REAL status transition (… → Completed) on
--     public.assignments notifies the assigner, the department head(s) and management, once
--     per completion (a later rework → complete is a new event).
--
--   erp_now()  — server clock for reminder eligibility (never the browser's clock).
-- Realtime: published, so open portals receive new rows instantly. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.erp_notifications (
  id                     uuid primary key default gen_random_uuid(),
  recipient_email        text not null,
  recipient_employee_id  uuid,
  type                   text not null,
  title                  text not null,
  message                text,
  entity_type            text,
  entity_id              text,
  dedupe_key             text not null,
  link                   text,
  metadata               jsonb not null default '{}',
  created_at             timestamptz not null default now(),
  read_at                timestamptz,
  resolved_at            timestamptz,
  snooze_until           timestamptz
);
-- recipient_email is always stored lower-case (clients + trigger), so a plain unique index works
-- for PostgREST upserts (on_conflict=recipient_email,dedupe_key).
create unique index if not exists uq_erp_notif_dedupe on public.erp_notifications (recipient_email, dedupe_key);
create index if not exists idx_erp_notif_recipient on public.erp_notifications (recipient_email, created_at desc);
create index if not exists idx_erp_notif_open on public.erp_notifications (type, resolved_at) where resolved_at is null;

alter table public.erp_notifications enable row level security;
drop policy if exists erp_notif_all on public.erp_notifications;
-- Same access model as the rest of the ERP (portals use the anon key).
create policy erp_notif_all on public.erp_notifications for all using (true) with check (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'erp_notifications') then
    execute 'alter publication supabase_realtime add table public.erp_notifications';
  end if;
end $$;

create or replace function public.erp_now() returns timestamptz language sql stable as $$ select now() $$;

-- ── Work completed → notify management ───────────────────────────────────────
create or replace function public.erp_notify_work_completed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_emp       record;
  v_has_out   boolean;
  v_media     boolean;
  v_who       text;
  v_dep       text;
  v_title     text;
  v_msg       text;
  v_at        text;
  v_key       text;
  v_completer text;
begin
  if new.status is distinct from 'Completed' or old.status is not distinct from 'Completed' then
    return new;
  end if;
  v_has_out   := coalesce(nullif(trim(new.asset_link::text), ''), '') <> '';
  v_media     := coalesce(new.department::text, '') = 'production' or coalesce(new.scope::text, '') = 'media';
  v_who       := coalesce(nullif(new.final_submitted_by::text, ''), nullif(new.assigned_to::text, ''), 'An employee');
  v_dep       := case coalesce(new.department::text, '')
                   when 'production' then 'Media' when 'education' then 'Academic' when 'sales' then 'Sales'
                   when 'hr' then 'HR' when 'management' then 'Management' else 'Work' end;
  -- One event per completion: the completion timestamp is part of the key, so re-saving a
  -- completed record never repeats it, while rework → complete again is a new event.
  v_at        := coalesce(new.completed_at::text, new.submitted_at::text, now()::text);
  v_key       := 'work_completed:' || new.id::text || ':' || v_at;
  v_completer := lower(coalesce(new.employee_email::text, ''));
  v_title := case when v_media and v_has_out then 'Video Ready for Review' else 'Work Completed' end;
  v_msg := v_who || ' completed: “' || coalesce(new.topic, 'Task') || '”' ||
           case when v_has_out then '. Final output has been uploaded and is ready for review.' else '.' end;

  for v_emp in
    select distinct on (lower(e.portal_email)) e.id, lower(e.portal_email) as email
    from public.hr_employees e
    where coalesce(e.portal_email, '') <> ''
      and coalesce(e.account_type, '') <> 'system'
      and coalesce(lower(e.employment_status), 'active') not in ('exited', 'inactive')
      and lower(e.portal_email) <> v_completer
      and (
        -- the person who assigned it (assignments keep the assigner's name / email as text)
        lower(e.full_name) = lower(coalesce(new.assigned_by, ''))
        or lower(e.full_name) = lower(coalesce(new.created_by, ''))
        or lower(e.portal_email) = lower(coalesce(new.created_by, ''))
        -- management with organisation-wide work visibility
        or lower(coalesce(e.system_role, '')) in ('manager', 'founder', 'co_founder', 'managing_director', 'director')
        or coalesce(e.account_type, '') = 'management'
        -- the head of the task's department
        or (new.department = 'production' and lower(coalesce(e.system_role, '')) = 'media_head')
        or (new.department = 'education' and (lower(coalesce(e.system_role, '')) = 'academic_head'
              or e.designation ~* '^(senior |junior )?(academic head|class coordinator|operations manager)$'))
        or (new.department = 'hr' and (lower(coalesce(e.system_role, '')) = 'hr_admin' or (e.division = 'hr' and e.designation ~* 'head|manager')))
        or (new.department = 'sales' and e.division = 'sales' and e.designation ~* 'head|manager')
      )
  loop
    insert into public.erp_notifications (recipient_email, recipient_employee_id, type, title, message, entity_type, entity_id, dedupe_key, link, metadata)
    values (v_emp.email, v_emp.id, case when v_has_out then 'work_output_uploaded' else 'work_completed' end, v_title, v_msg,
            'assignment', new.id::text, v_key, 'work:' || new.id::text,
            jsonb_build_object('employee', v_who, 'topic', new.topic, 'department', v_dep, 'has_output', v_has_out,
                               'completed_at', v_at))
    on conflict (recipient_email, dedupe_key) do nothing;
  end loop;
  return new;
exception when others then
  -- A notification problem must never block the work update itself.
  raise warning 'erp_notify_work_completed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists trg_assignments_work_completed on public.assignments;
create trigger trg_assignments_work_completed
  after update of status on public.assignments
  for each row execute function public.erp_notify_work_completed();
