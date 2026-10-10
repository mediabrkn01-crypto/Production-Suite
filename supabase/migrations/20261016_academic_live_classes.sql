-- ════════════════════════════════════════════════════════════════════════════
-- Academic → LIVE CLASSES (Google Calendar + Google Meet layer).
--
-- The ERP stays the source of truth. A "class" is still what it always was:
--   • a batch occurrence generated from batches.day_pattern / time_slot (+ class_postponements)
--       → occurrence_key  'class:<batch_id>:<original_date>'
--   • a group-course 1:1 session row in oto_sessions
--       → occurrence_key  'oto:<oto_sessions.id>'
-- This table only LINKS one class occurrence to its Google Calendar event / Meet link. It never
-- copies the class. A postponed class keeps the same key (original date), so the same Calendar
-- event is updated in place — never a second event.
--
-- Writes happen ONLY through the `academic-meet` edge function (service role): the browser can
-- read these rows (for the Live Classes tab + realtime) but cannot insert/update them.
-- academic_meet_config holds the organizer's OAuth refresh token — no browser access at all.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.academic_live_classes (
  id                          uuid primary key default gen_random_uuid(),
  occurrence_key              text not null unique,
  class_kind                  text not null check (class_kind in ('class', 'oto')),
  batch_id                    uuid,
  oto_session_id              uuid,
  trainer_id                  uuid,
  original_date               date,
  class_date                  date not null,
  start_time                  time,
  end_time                    time,
  class_status                text not null default 'scheduled' check (class_status in ('scheduled', 'cancelled')),
  summary                     text,

  google_calendar_id          text,
  google_calendar_event_id    text,
  google_meet_space_name      text,
  google_meet_url             text,
  google_meet_code            text,
  organizer_email             text,
  google_sync_status          text not null default 'pending'
                              check (google_sync_status in ('pending', 'syncing', 'synced', 'failed', 'cancelled')),
  google_sync_error           text,
  last_google_sync_at         timestamptz,
  reminder_minutes            integer[] not null default '{30}',

  -- Who was invited / who could not be (missing or invalid email) — shown in the class modal.
  invited                     jsonb not null default '[]',
  not_invited                 jsonb not null default '[]',

  -- Future: Meet conference record → participants → SUGGESTED attendance (trainer verifies).
  google_conference_record    text,
  meet_participants           jsonb,
  attendance_suggestion       jsonb,
  attendance_suggested_at     timestamptz,

  created_by                  text,
  updated_by                  text,
  cancelled_by                text,
  cancelled_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists idx_alc_date    on public.academic_live_classes (class_date);
create index if not exists idx_alc_batch   on public.academic_live_classes (batch_id);
create index if not exists idx_alc_trainer on public.academic_live_classes (trainer_id);
create unique index if not exists uq_alc_event on public.academic_live_classes (google_calendar_event_id) where google_calendar_event_id is not null;

-- Batches whose classes are held online: Live Classes creates the Meet for their upcoming
-- classes automatically ("Create online class" on Create Batch, or the toggle in Live Classes).
create table if not exists public.academic_meet_batches (
  batch_id    uuid primary key,
  online      boolean not null default true,
  set_by      text,
  updated_at  timestamptz not null default now()
);

-- One row (id = 1): the Broken English organizer Google account + defaults.
create table if not exists public.academic_meet_config (
  id                 integer primary key default 1 check (id = 1),
  organizer_email    text,
  calendar_id        text not null default 'primary',
  refresh_token      text,
  default_reminders  integer[] not null default '{30}',
  connected_by       text,
  connected_at       timestamptz,
  updated_at         timestamptz not null default now()
);
insert into public.academic_meet_config (id) values (1) on conflict (id) do nothing;

alter table public.academic_live_classes enable row level security;
alter table public.academic_meet_batches enable row level security;
alter table public.academic_meet_config  enable row level security;

drop policy if exists alc_read on public.academic_live_classes;
create policy alc_read on public.academic_live_classes for select using (true);
-- (no insert/update/delete policy → only the edge function's service role writes)

drop policy if exists amb_all on public.academic_meet_batches;
create policy amb_all on public.academic_meet_batches for all using (true) with check (true);
-- academic_meet_config: no policies at all → never readable from the browser.

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'academic_live_classes') then
    execute 'alter publication supabase_realtime add table public.academic_live_classes';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'academic_meet_batches') then
    execute 'alter publication supabase_realtime add table public.academic_meet_batches';
  end if;
end $$;
