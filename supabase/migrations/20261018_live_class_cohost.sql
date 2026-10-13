-- Live Classes: the class trainer is made Google Meet COHOST (organizer account stays owner).
-- cohost_status: pending | assigned | missing_email | failed. Safe to re-run.
alter table public.academic_live_classes
  add column if not exists trainer_email      text,
  add column if not exists trainer_meet_role  text,
  add column if not exists cohost_status      text not null default 'pending',
  add column if not exists cohost_error       text;
alter table public.academic_live_classes drop constraint if exists alc_cohost_chk;
alter table public.academic_live_classes add constraint alc_cohost_chk check (cohost_status in ('pending', 'assigned', 'missing_email', 'failed'));
