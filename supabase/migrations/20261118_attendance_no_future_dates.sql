-- No attendance for a class that hasn't happened yet (Academic trainer attendance fix, 2026-11-18).
--
-- Root cause of "September-completed batches showing October attendance": attendance rows were
-- saved with a session_date LATER than the day they were saved (a future date picked in the
-- Class Date field, or legacy imports whose day/month were swapped). Reports filter by
-- session_date, so those rows appeared as classes of a later month — even after the batch was
-- completed. The Academic UI now excludes such rows (academic-rules.js) and refuses future
-- dates; this trigger enforces the same rule for every NEW write.
--
-- Existing rows are NOT touched (no delete, no rewrite) — they are listed for review in
-- Academic → Overview → Data Issues. Day boundary = ERP time (Asia/Kolkata).
-- Only INSERT and an UPDATE that changes session_date are checked, so renaming a batch
-- (which updates batch_name on old rows) keeps working.

create or replace function public.attendance_no_future_date()
returns trigger
language plpgsql
as $$
begin
  if new.session_date is not null
     and new.session_date > (now() at time zone 'Asia/Kolkata')::date
     and (tg_op = 'INSERT' or new.session_date is distinct from old.session_date) then
    raise exception 'Class date % is in the future. Attendance can only be marked on or after the day the class is held.', new.session_date
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_no_future_date on public.attendance;
create trigger attendance_no_future_date
  before insert or update of session_date on public.attendance
  for each row execute function public.attendance_no_future_date();
