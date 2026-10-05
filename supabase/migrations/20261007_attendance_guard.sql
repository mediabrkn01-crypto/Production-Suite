-- ════════════════════════════════════════════════════════════════════════════
-- No second clock-in on a completed day — enforced by the database, not just the UI.
--
-- One row per employee per day already exists as a unique constraint on both tables
-- (attendance_logs: employee_email+log_date, hr_attendance: employee_id+att_date), so a second
-- INSERT is impossible. What was still possible: an UPDATE that starts the day again after
-- clock-out (clears the clock-out or moves the clock-in). These triggers reject that with
--   "Today’s attendance has already been completed."
-- unless the same update also sets a new reopened_at — the protected "Re-open attendance"
-- action (HR / admin / management, behind a confirmation) — which is recorded in hr_audit_log.
-- HR status changes (Present/Absent/Leave…) and corrections that keep the clock-in are unaffected.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.attendance_logs
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_by text;
alter table public.hr_attendance
  add column if not exists reopened_at timestamptz;

-- Clear message instead of a raw duplicate-key error for a second clock-in.
create or replace function public.trg_attendance_logs_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.attendance_logs l
               where lower(l.employee_email) = lower(new.employee_email) and l.log_date = new.log_date) then
      if exists (select 1 from public.attendance_logs l
                 where lower(l.employee_email) = lower(new.employee_email) and l.log_date = new.log_date and l.log_out_time is not null) then
        raise exception 'Today’s attendance has already been completed.' using errcode = 'P0001';
      end if;
      raise exception 'Already clocked in today.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- UPDATE on a completed day: re-starting it needs the protected re-open.
  if old.log_out_time is not null
     and (new.log_out_time is null or new.log_in_time is distinct from old.log_in_time)
     and new.reopened_at is not distinct from old.reopened_at then
    raise exception 'Today’s attendance has already been completed.' using errcode = 'P0001';
  end if;
  return new;
end; $$;
drop trigger if exists attendance_logs_guard on public.attendance_logs;
create trigger attendance_logs_guard
  before insert or update on public.attendance_logs
  for each row execute function public.trg_attendance_logs_guard();

create or replace function public.trg_hr_attendance_clock_guard()
returns trigger language plpgsql as $$
begin
  if old.clock_out_time is not null
     and old.clock_in_time is not null
     and (new.clock_out_time is null or new.clock_in_time is distinct from old.clock_in_time)
     and new.reopened_at is not distinct from old.reopened_at then
    raise exception 'Today’s attendance has already been completed.' using errcode = 'P0001';
  end if;
  return new;
end; $$;
drop trigger if exists hr_attendance_clock_guard on public.hr_attendance;
create trigger hr_attendance_clock_guard
  before update on public.hr_attendance
  for each row execute function public.trg_hr_attendance_clock_guard();
