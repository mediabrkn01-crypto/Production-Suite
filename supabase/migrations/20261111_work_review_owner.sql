-- ============================================================================
-- Work Assignment: assigner-owned review for cross-department work.
--
-- Until now an assignment only carried its creator's NAME (created_by / assigned_by), and every
-- non-'org' Completed row went to the Media Head's Work Approvals — so work an Operations
-- Manager / Department Head / HR gave to a Video Editor landed with the Media Head.
--
-- New, additive columns:
--   created_by_id   hr_employees.id of the person who created the assignment (ownership)
--   reviewer_id     hr_employees.id who owns the review (the assigner)
--   review_route    'assigner' = reviewed by reviewer_id through the work function;
--                   NULL / 'media' = the existing workflow (Media Work Approvals) — unchanged
--   approved_by_id / reviewed_by_id / rejected_by_id   who actually acted (names stay in the
--                   existing approved_by / reviewed_by / rejected_by text columns)
--
-- Existing rows keep review_route NULL, so every existing Media assignment and approval behaves
-- exactly as before. created_by_id is backfilled only where the stored creator name matches
-- exactly ONE HR record (names and history are not touched).
--
-- Guard trigger: browser (anon / authenticated) requests can never set or change ownership /
-- routing / reviewer-id columns, and can never approve, reject or send back an
-- assigner-reviewed row. Only the server (service role: supabase/functions/work) can.
-- Employees still submit (status → Completed + output) from their own screens as before.
-- ============================================================================
alter table public.assignments add column if not exists created_by_id  uuid references public.hr_employees(id) on delete set null;
alter table public.assignments add column if not exists reviewer_id    uuid references public.hr_employees(id) on delete set null;
alter table public.assignments add column if not exists review_route   text;
alter table public.assignments add column if not exists approved_by_id uuid;
alter table public.assignments add column if not exists reviewed_by_id uuid;
alter table public.assignments add column if not exists rejected_by_id uuid;
alter table public.assignments drop constraint if exists assignments_review_route_check;
alter table public.assignments add constraint assignments_review_route_check check (review_route is null or review_route in ('media', 'assigner'));
create index if not exists idx_assignments_created_by_id on public.assignments (created_by_id);
create index if not exists idx_assignments_reviewer_id   on public.assignments (reviewer_id);

-- Backfill ownership by an unambiguous creator name (one HR record with that name).
update public.assignments a
   set created_by_id = e.id
  from (select lower(trim(full_name)) n, (array_agg(id))[1] id, count(*) c
          from public.hr_employees where coalesce(account_type, '') <> 'system' and coalesce(full_name, '') <> ''
         group by 1) e
 where a.created_by_id is null and e.c = 1
   and e.n = lower(trim(coalesce(nullif(a.created_by, ''), a.assigned_by)));

-- ── Guard: review/ownership columns are server-only ──────────────────────────
create or replace function public.trg_assignments_review_guard()
returns trigger language plpgsql as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
begin
  if v_role not in ('anon', 'authenticated') then return new; end if;   -- service role, SQL, other triggers
  if tg_op = 'INSERT' then
    -- Ownership and routing come only from the server-checked create path.
    new.created_by_id := null; new.reviewer_id := null; new.review_route := null;
    new.approved_by_id := null; new.reviewed_by_id := null; new.rejected_by_id := null;
    return new;
  end if;
  if new.created_by_id  is distinct from old.created_by_id  or new.reviewer_id    is distinct from old.reviewer_id
  or new.review_route   is distinct from old.review_route   or new.approved_by_id is distinct from old.approved_by_id
  or new.reviewed_by_id is distinct from old.reviewed_by_id or new.rejected_by_id is distinct from old.rejected_by_id then
    raise exception 'Work ownership and review fields can only be changed by the server.' using errcode = '42501';
  end if;
  if old.review_route = 'assigner' and (
       new.manager_approved is distinct from old.manager_approved
    or new.approved_by      is distinct from old.approved_by      or new.approved_at  is distinct from old.approved_at
    or new.reviewed_by      is distinct from old.reviewed_by      or new.reviewed_at  is distinct from old.reviewed_at
    or new.rejected_by      is distinct from old.rejected_by      or new.rejected_at  is distinct from old.rejected_at
    or new.rework_reason    is distinct from old.rework_reason    or new.rejection_reason is distinct from old.rejection_reason
    or (new.status is distinct from old.status and new.status in ('Rework Required', 'Rejected'))) then
    raise exception 'This work is reviewed by the person who assigned it — use Approve / Send for rework in Work Assignment.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_assignments_review_guard on public.assignments;
create trigger trg_assignments_review_guard before insert or update on public.assignments
  for each row execute function public.trg_assignments_review_guard();

-- ── Submission notification: assigner-reviewed work goes to its reviewer (+ leadership), never
--    to the department head of the employee's department. Everything else is unchanged. ──
create or replace function public.erp_notify_work_completed()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
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
  for v_emp in
    select distinct on (lower(e.portal_email)) e.id, lower(e.portal_email) email
      from public.hr_employees e
     where new.review_route = 'assigner'
       and coalesce(e.portal_email, '') <> '' and coalesce(e.account_type, '') <> 'system'
       and coalesce(lower(e.employment_status), 'active') not in ('exited', 'inactive')
       and lower(e.portal_email) <> lower(coalesce(new.employee_email, ''))
       and (e.id = new.reviewer_id
            or lower(coalesce(e.system_role, '')) in ('manager', 'founder', 'co_founder', 'managing_director', 'director')
            or coalesce(e.account_type, '') = 'management')
    union all
    select r.id, r.email from public.erp_work_recipients(v_dept, new.assigned_by, new.created_by, new.employee_email) r
     where new.review_route is distinct from 'assigner'
  loop
    insert into public.erp_notifications (recipient_email, recipient_employee_id, type, title, message, entity_type, entity_id, dedupe_key, link, metadata)
    values (v_emp.email, v_emp.id, case when v_has_out then 'work_output_uploaded' else 'work_completed' end, v_title, v_msg,
            'assignment', new.id::text, v_key, 'work:' || new.id::text,
            jsonb_build_object('employee', v_who, 'topic', new.topic, 'department', v_dep, 'has_output', v_has_out,
                               'completed_at', v_at, 'project_id', new.project_id, 'project', v_project, 'classification', new.type,
                               'review_route', new.review_route))
    on conflict (recipient_email, dedupe_key) do nothing;
  end loop;
  return new;
exception when others then
  raise warning 'erp_notify_work_completed: %', sqlerrm;
  return new;
end $function$;
