-- No one decides their own leave (HR My Workspace, 2026-11-17).
-- An HR officer now applies for leave from My Workspace in the HR portal. The HR leave screen
-- already hides Approve / Reject / Exception / type-change on the officer's own request and
-- decideHRLeave() refuses it; this trigger enforces the same rule in the database.
--
-- The decider is recorded in hr_by / exception_by as the actor's full name (decideHRLeave writes
-- activeUser there), so a decision whose decider name equals the requesting employee's
-- full_name is rejected. Pending requests, cancellations and edits that do not decide are untouched.
-- Limitation: the portal uses the anon key, so the database cannot verify WHO is calling — this
-- blocks the app's approval paths, not a hand-crafted request that writes a different name.

create or replace function public.hr_leave_no_self_decision()
returns trigger
language plpgsql
as $$
declare
  emp_name text;
begin
  -- only when this update makes or changes a decision
  if not (
       (new.status in ('approved', 'rejected') and new.status is distinct from old.status)
    or (new.exception_by is not null and new.exception_by is distinct from old.exception_by)
    or (new.hr_by is not null and new.hr_by is distinct from old.hr_by)
  ) then
    return new;
  end if;

  select lower(trim(full_name)) into emp_name from public.hr_employees where id = new.employee_id;
  if emp_name is null or emp_name = '' then
    return new;
  end if;

  -- a decider field newly set to the requester's own name = self-decision
  if (new.hr_by is distinct from old.hr_by and lower(trim(coalesce(new.hr_by, ''))) = emp_name)
     or (new.exception_by is distinct from old.exception_by and lower(trim(coalesce(new.exception_by, ''))) = emp_name)
     or (new.manager_by is distinct from old.manager_by and lower(trim(coalesce(new.manager_by, ''))) = emp_name) then
    raise exception 'Leave request % cannot be decided by the employee who requested it', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hr_leave_no_self_decision on public.hr_leave_requests;
create trigger hr_leave_no_self_decision
  before update on public.hr_leave_requests
  for each row execute function public.hr_leave_no_self_decision();
