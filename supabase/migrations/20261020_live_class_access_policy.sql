-- Live Classes: remember whether the organizer account can grant Meet co-host
-- (true = Google Workspace → controlled rooms + trainer co-host; false = personal Gmail → open link).
alter table public.academic_meet_config add column if not exists cohost_supported boolean;
