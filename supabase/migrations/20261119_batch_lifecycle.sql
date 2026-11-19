-- ════════════════════════════════════════════════════════════════════════════
-- BATCH LIFECYCLE — audit log + safe reconciliation of finished-but-still-open batches.
-- Safe to re-run. Nothing is deleted; attendance, 1:1 sessions, students and batches rows are
-- never modified except batches.status / completed_at on batches that are verifiably finished.
--
-- Root cause (fixed in academics.html): a batch only moved to Finished Batches when
-- batches.status became 'completed', and only the group-attendance save wrote that. A group
-- course with included 1:1 sessions finishes on its LAST 1:1 session, which never ran the check,
-- so such batches stayed status='active' in the trainer's My Batches forever.
--
-- Completion rule (same as the app's _acadCompletionState):
--   group phase done = group_classes_completed_at set OR distinct present-dated sessions >= sessions_total
--   1:1 phase done   = every non-Dropped student has >= course.oto_sessions_required completed
--                      oto_sessions (group courses only; standalone 1:1 batches need none)
--   not frozen, not archived/deleted.  Never by date alone.
--
-- HOW TO USE
--   1. Preview (changes nothing):   select * from public.batch_completion_audit where ready;
--   2. Apply:                       select * from public.reconcile_finished_batches(true);
--      Every batch it closes gets a row in batch_lifecycle_log (action 'reconciled').
-- ════════════════════════════════════════════════════════════════════════════

-- 1 · audit log -------------------------------------------------------------------------------
create table if not exists public.batch_lifecycle_log (
  id          bigint generated always as identity primary key,
  batch_id    uuid,
  batch_name  text,
  action      text not null,          -- auto_completed | reconciled | restored | head_closed_verified
  reason      text,
  details     jsonb,
  by_name     text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_batch_lifecycle_log_batch on public.batch_lifecycle_log (batch_id, created_at desc);
comment on table public.batch_lifecycle_log is 'Audit trail of batch status changes (auto close, Head close, restore, reconciliation).';

-- Same access model as the other Academic class tables (oto_sessions, class_postponements).
alter table public.batch_lifecycle_log enable row level security;
do $$ begin
  create policy "batch_lifecycle_log_all" on public.batch_lifecycle_log for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 2 · read-only report: every OPEN batch with its real completion state --------------------------
create or replace view public.batch_completion_audit as
with b as (
  select bt.*, to_jsonb(bt) as j from public.batches bt
  where coalesce(bt.status, '') not in ('completed', 'finished')
),
grp as (
  select batch_name, count(distinct session_date) as done, max(session_date) as last_class
  from public.attendance
  where status = 'present' and session_date is not null
  group by batch_name
),
req as (
  select b.id,
         case when c.type = 'group' and coalesce(b.capacity, 0) <> 1
              then coalesce(c.oto_sessions_required, 0) else 0 end as oto_req
  from b left join public.courses c on c.id = b.course_id
),
stu as (
  select s.batch_id, s.id as student_id, s.name
  from public.students s
  where coalesce(s.status, '') <> 'Dropped'
),
otoc as (
  select batch_id, student_id, count(*) as n, max(coalesce(session_date::timestamptz, marked_at)) as last_oto
  from public.oto_sessions
  where status = 'completed'
  group by batch_id, student_id
),
pend as (
  select stu.batch_id,
         sum(greatest(req.oto_req - coalesce(otoc.n, 0), 0)) as oto_pending,
         string_agg(case when req.oto_req > coalesce(otoc.n, 0) then stu.name end, ', ') as pending_students,
         max(otoc.last_oto) as last_oto
  from stu
  join req on req.id = stu.batch_id
  left join otoc on otoc.batch_id = stu.batch_id and otoc.student_id = stu.student_id
  where req.oto_req > 0
  group by stu.batch_id
)
select
  b.id, b.name, b.status, b.trainer_id,
  b.sessions_total,
  coalesce(grp.done, 0)                                            as group_done,
  b.group_classes_completed_at,
  req.oto_req                                                      as oto_required_per_student,
  coalesce(pend.oto_pending, 0)                                    as oto_pending,
  pend.pending_students,
  (b.group_classes_completed_at is not null
     or (coalesce(b.sessions_total, 0) > 0 and coalesce(grp.done, 0) >= b.sessions_total)) as group_phase_done,
  (b.status = 'frozen' or (b.j ->> 'frozen_at') is not null)       as frozen,
  ((b.j ->> 'deleted_at') is not null)                             as archived,
  greatest(grp.last_class::timestamptz + interval '23 hours 59 minutes', pend.last_oto) as last_activity,
  ( (b.group_classes_completed_at is not null
       or (coalesce(b.sessions_total, 0) > 0 and coalesce(grp.done, 0) >= b.sessions_total))
    and coalesce(pend.oto_pending, 0) = 0
    and not (b.status = 'frozen' or (b.j ->> 'frozen_at') is not null)
    and (b.j ->> 'deleted_at') is null )                           as ready
from b
left join grp  on grp.batch_name = b.name
left join req  on req.id = b.id
left join pend on pend.batch_id = b.id;

comment on view public.batch_completion_audit is
  'Open batches with their verified completion state. ready = every required group and 1:1 session is done (not frozen, not archived). Read-only.';

-- 3 · reconciliation: close ONLY verified-finished batches, logged, re-runnable ------------------
-- p_apply = false → dry run (returns what WOULD be closed). completed_at is set to the batch's
-- real last activity (last class / last 1:1), not today, so reports keep the right month.
create or replace function public.reconcile_finished_batches(p_apply boolean default false)
returns table (batch_id uuid, batch_name text, completed_at timestamptz, applied boolean)
language plpgsql as $$
declare r record; n int;
begin
  for r in select a.* from public.batch_completion_audit a where a.ready order by a.name loop
    batch_id := r.id; batch_name := r.name; completed_at := coalesce(r.last_activity, now()); applied := false;
    if p_apply then
      update public.batches set status = 'completed', completed_at = coalesce(r.last_activity, now())
       where id = r.id and coalesce(status, '') not in ('completed', 'finished');
      get diagnostics n = row_count;
      if n > 0 then
        applied := true;
        insert into public.batch_lifecycle_log (batch_id, batch_name, action, reason, details, by_name)
        values (r.id, r.name, 'reconciled', 'all group and 1:1 sessions verified complete',
                jsonb_build_object('group', r.group_done || '/' || coalesce(r.sessions_total, 0),
                                   'group_phase_closed_at', r.group_classes_completed_at,
                                   'oto_required_per_student', r.oto_required_per_student,
                                   'previous_status', r.status),
                'reconcile_finished_batches');
      end if;
    end if;
    return next;
  end loop;
end; $$;

comment on function public.reconcile_finished_batches(boolean) is
  'Closes open batches whose every required group and 1:1 session is verified done. Dry run by default; logged to batch_lifecycle_log; safe to re-run.';
