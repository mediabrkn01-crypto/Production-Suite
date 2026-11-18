-- Trainer profile repair (Google Meet "Only trainers with an Academic trainer profile…", 2026-11-18).
--
-- Root cause: an Education employee rehired under a NEW HR record (same name, new email) kept
-- their trainer profile linked to the OLD, now inactive HR record. trainers.name is unique
-- (trainers_name_unique = one profile per person), so the HR → Academic sync could never give
-- the new record a profile; both HR records wrote to the same row in parallel and the old one
-- kept winning. academic-meet then found no profile linked to the signed-in employee.
--
-- Repair (same rule the fixed sync in academics.html now applies): a profile linked to an
-- inactive/exited HR record moves to the ONE active Education trainer/coach record with the
-- same name that has no profile of its own. Nothing is deleted or created; batches, attendance
-- and session history keep pointing at the same trainers row. Ambiguous cases (several active
-- records with the name) are left alone. Safe to re-run.

-- 1) Review: what will be relinked (old → new HR record).
with heirs as (
  select t.id as trainer_id, t.name, old.employee_id as old_emp, new.employee_id as new_emp, new.id as new_id,
         count(*) over (partition by t.id) as candidates
  from public.trainers t
  join public.hr_employees old on old.id = t.hr_employee_id
  join public.hr_employees new on new.id <> old.id and lower(trim(new.full_name)) = lower(trim(t.name))
  where lower(coalesce(old.employment_status, 'active')) in ('inactive', 'exited')
    and new.division = 'education'
    and lower(coalesce(new.employment_status, 'active')) not in ('inactive', 'exited')
    and (lower(coalesce(new.system_role, '')) = 'trainer' or concat_ws(' ', new.department, new.designation) ~* 'coach|trainer')
    and not exists (select 1 from public.trainers t2 where t2.hr_employee_id = new.id)
)
select * from heirs where candidates = 1;

-- 2) Relink.
with heirs as (
  select t.id as trainer_id, new.id as new_id, new.portal_email, new.employment_type,
         count(*) over (partition by t.id) as candidates
  from public.trainers t
  join public.hr_employees old on old.id = t.hr_employee_id
  join public.hr_employees new on new.id <> old.id and lower(trim(new.full_name)) = lower(trim(t.name))
  where lower(coalesce(old.employment_status, 'active')) in ('inactive', 'exited')
    and new.division = 'education'
    and lower(coalesce(new.employment_status, 'active')) not in ('inactive', 'exited')
    and (lower(coalesce(new.system_role, '')) = 'trainer' or concat_ws(' ', new.department, new.designation) ~* 'coach|trainer')
    and not exists (select 1 from public.trainers t2 where t2.hr_employee_id = new.id)
)
update public.trainers t
set hr_employee_id = h.new_id,
    status = 'active',
    portal_email = h.portal_email,
    type = case when h.employment_type = 'part_time' then 'pt' else 'ft' end
from heirs h
where t.id = h.trainer_id and h.candidates = 1
returning t.id, t.name, t.hr_employee_id, t.status, t.type;
