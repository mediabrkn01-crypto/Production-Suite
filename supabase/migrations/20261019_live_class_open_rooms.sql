-- Live Classes: OPEN Meet rooms (anyone with the link joins, no knocking) + co-host "unsupported"
-- (a personal Gmail organizer can't add co-hosts; Google Workspace can). Safe to re-run.
alter table public.academic_live_classes add column if not exists google_meet_access text;
alter table public.academic_live_classes drop constraint if exists alc_cohost_chk;
alter table public.academic_live_classes add constraint alc_cohost_chk
  check (cohost_status in ('pending', 'assigned', 'missing_email', 'failed', 'unsupported'));
