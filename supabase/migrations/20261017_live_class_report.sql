-- ════════════════════════════════════════════════════════════════════════════
-- Live Classes, part 2: review email, Join Live / End Class, Meet report, class history.
--
--   academic_meet_config.review_email   always invited to every class event (Academic review)
--   academic_live_classes               ERP live state (Join Live / End Class = ERP activity only)
--                                       + the OFFICIAL Meet report from Google conference records
--                                       (actual start/end/duration, trainer presence, participants)
--                                       + attendance review status (suggestions only — confirmed
--                                       attendance is still saved by Class & Attendance).
--   academic_live_class_events          class history with timestamps.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.academic_meet_config
  add column if not exists review_email text default 'reviewbrk@gmail.com';
update public.academic_meet_config set review_email = 'reviewbrk@gmail.com' where id = 1 and review_email is null;

alter table public.academic_live_classes
  add column if not exists scheduled_start           timestamptz,
  add column if not exists scheduled_end             timestamptz,
  add column if not exists live_status               text not null default 'scheduled',
  add column if not exists joined_at                 timestamptz,
  add column if not exists joined_by                 text,
  add column if not exists ended_at                  timestamptz,
  add column if not exists ended_by                  text,
  add column if not exists actual_start              timestamptz,
  add column if not exists actual_end                timestamptz,
  add column if not exists actual_duration_minutes   integer,
  add column if not exists trainer_join_at           timestamptz,
  add column if not exists trainer_leave_at          timestamptz,
  add column if not exists trainer_presence_minutes  integer,
  add column if not exists meet_sync_status          text not null default 'none',
  add column if not exists meet_sync_error           text,
  add column if not exists meet_report_synced_at     timestamptz,
  add column if not exists attendance_review_status  text not null default 'none';

alter table public.academic_live_classes drop constraint if exists alc_live_status_chk;
alter table public.academic_live_classes add constraint alc_live_status_chk check (live_status in ('scheduled', 'live', 'ended'));
alter table public.academic_live_classes drop constraint if exists alc_meet_sync_chk;
alter table public.academic_live_classes add constraint alc_meet_sync_chk check (meet_sync_status in ('none', 'pending', 'waiting', 'synced', 'failed'));
alter table public.academic_live_classes drop constraint if exists alc_att_review_chk;
alter table public.academic_live_classes add constraint alc_att_review_chk check (attendance_review_status in ('none', 'ready', 'confirmed'));

create table if not exists public.academic_live_class_events (
  id              bigserial primary key,
  occurrence_key  text not null,
  event           text not null,
  detail          text,
  actor           text,
  at              timestamptz not null default now()
);
create index if not exists idx_alce_key on public.academic_live_class_events (occurrence_key, at);
-- Meet-derived events (trainer joined, meeting started/ended) are written once per report sync.
create unique index if not exists uq_alce_once on public.academic_live_class_events (occurrence_key, event, at);

alter table public.academic_live_class_events enable row level security;
drop policy if exists alce_read on public.academic_live_class_events;
create policy alce_read on public.academic_live_class_events for select using (true);
-- writes: edge function (service role) only

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'academic_live_class_events') then
    execute 'alter publication supabase_realtime add table public.academic_live_class_events';
  end if;
end $$;
