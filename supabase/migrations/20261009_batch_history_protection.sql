-- ════════════════════════════════════════════════════════════════════════════
-- Batch history protection — class / attendance / payroll evidence can never be destroyed
-- by removing a batch.
--
-- Findings (2026-10-06): no batch relationship cascades. Finished-batch "Delete" was already a
-- soft delete (batches.deleted_at), and every attendance / 1:1 / trainer-pay row of the 28
-- batches archived on 06 Oct is still in the database. They were only HIDDEN by reports that
-- skipped archived/finished batches (fixed in academics.html). This migration makes the rule
-- permanent at the database level:
--
-- 1. A batch that has any history (attendance, 1:1 sessions, trainer pay, students) cannot be
--    hard-deleted — the app archives instead (deleted_at). Batches with no history (e.g. a
--    mistaken upcoming batch) can still be removed.
-- 2. Every attendance row keeps an immutable snapshot of the batch it was marked for
--    (batch id, trainer, course, class length, class type) taken at insert time, so history
--    never depends on the live batch row — even if the trainer or course later changes.
--    Existing rows are back-filled from the current batch (best available record).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. No hard delete of a batch with history ------------------------------------------------
create or replace function public.trg_batches_protect_history()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.attendance a where a.batch_name = old.name)
     or exists (select 1 from public.oto_sessions o where o.batch_id = old.id)
     or exists (select 1 from public.trainer_session_earnings e where e.batch_id = old.id)
     or exists (select 1 from public.students s where s.batch_id = old.id) then
    raise exception 'Batch "%" has class, attendance or payroll history and cannot be permanently deleted. Archive it instead.', old.name
      using errcode = 'P0001';
  end if;
  return old;
end; $$;
drop trigger if exists batches_protect_history on public.batches;
create trigger batches_protect_history
  before delete on public.batches
  for each row execute function public.trg_batches_protect_history();

-- 2. Attendance snapshot columns ------------------------------------------------------------
alter table public.attendance
  add column if not exists batch_id_snapshot uuid,
  add column if not exists trainer_id_snapshot uuid,
  add column if not exists trainer_name_snapshot text,
  add column if not exists course_snapshot text,
  add column if not exists class_duration_snapshot integer,
  add column if not exists class_type_snapshot text;

create or replace function public.trg_attendance_snapshot()
returns trigger language plpgsql as $$
declare b record;
begin
  if new.batch_id_snapshot is null then
    select id, trainer_id, trainer_name, programme, class_duration_minutes, capacity
      into b from public.batches where name = new.batch_name
      order by (deleted_at is null) desc, created_at desc limit 1;
    if found then
      new.batch_id_snapshot       := b.id;
      new.trainer_id_snapshot     := coalesce(new.trainer_id_snapshot, b.trainer_id);
      new.trainer_name_snapshot   := coalesce(new.trainer_name_snapshot, b.trainer_name);
      new.course_snapshot         := coalesce(new.course_snapshot, b.programme);
      new.class_duration_snapshot := coalesce(new.class_duration_snapshot, nullif(b.class_duration_minutes, 0), 60);
      new.class_type_snapshot     := coalesce(new.class_type_snapshot, case when b.capacity = 1 then '1:1' else 'group' end);
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists attendance_snapshot on public.attendance;
create trigger attendance_snapshot
  before insert on public.attendance
  for each row execute function public.trg_attendance_snapshot();

-- Back-fill existing rows from their batch (current record — the best history available).
update public.attendance a set
  batch_id_snapshot       = b.id,
  trainer_id_snapshot     = b.trainer_id,
  trainer_name_snapshot   = b.trainer_name,
  course_snapshot         = b.programme,
  class_duration_snapshot = coalesce(nullif(b.class_duration_minutes, 0), 60),
  class_type_snapshot     = case when b.capacity = 1 then '1:1' else 'group' end
from public.batches b
where b.name = a.batch_name and a.batch_id_snapshot is null;

create index if not exists idx_attendance_trainer_snapshot on public.attendance (trainer_id_snapshot, session_date);
