-- ════════════════════════════════════════════════════════════════════════════
-- Live Classes — Google sync queue, per-component status, and Google limit protection.
--
-- Per class (academic_live_classes):
--   calendar_event_status / meet_status / trainer_invite_status / review_invite_status
--     ('pending' | 'ok' | 'failed' | 'missing_email' | 'not_configured')
--   trainer_calendar_invited   trainer email confirmed in the event's returned attendees
--   sync_attempts / next_retry_at / last_sync_attempt_at   capped exponential backoff + jitter
--   last_error_status / last_error_reason                  Google's HTTP status + error.reason
--   last_verified_at                                       last read-back check of the event
--   google_sync_status 'pending' + next_retry_at = queued (waiting for Google), never lost.
--
-- Organizer-wide (academic_meet_config): when Google answers "Calendar usage limits exceeded"
-- (quotaExceeded) every Calendar write pauses until calendar_paused_until; the pause doubles
-- on each repeat (capped) and resets after the first successful write.
-- queue_lock_until: only one queue run talks to Google at a time (concurrency 1).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.academic_live_classes
  add column if not exists calendar_event_status   text not null default 'pending',
  add column if not exists meet_status             text not null default 'pending',
  add column if not exists trainer_invite_status   text not null default 'pending',
  add column if not exists review_invite_status    text not null default 'pending',
  add column if not exists trainer_calendar_invited boolean not null default false,
  add column if not exists sync_attempts           integer not null default 0,
  add column if not exists next_retry_at           timestamptz,
  add column if not exists last_sync_attempt_at    timestamptz,
  add column if not exists last_error_status       integer,
  add column if not exists last_error_reason       text,
  add column if not exists last_verified_at        timestamptz;

-- co-host may also be "unsupported" (personal Gmail organizer cannot grant co-host)
alter table public.academic_live_classes drop constraint if exists alc_cohost_chk;
alter table public.academic_live_classes add constraint alc_cohost_chk
  check (cohost_status in ('pending', 'assigned', 'missing_email', 'failed', 'unsupported'));

create index if not exists idx_alc_sync_queue on public.academic_live_classes (google_sync_status, next_retry_at)
  where class_status = 'scheduled';

-- Existing rows: a Meet that exists counts as calendar + meet ok; invitations are re-verified
-- by the queue (verify pass) — nothing is recreated.
update public.academic_live_classes
   set calendar_event_status = case when google_calendar_event_id is not null then 'ok' else calendar_event_status end,
       meet_status           = case when google_meet_url is not null then 'ok' else meet_status end
 where calendar_event_status = 'pending';

alter table public.academic_meet_config
  add column if not exists calendar_paused_until timestamptz,
  add column if not exists calendar_pause_level  integer not null default 0,
  add column if not exists calendar_pause_reason text,
  add column if not exists calendar_last_error   jsonb,
  add column if not exists queue_lock_until      timestamptz;

-- Check
select google_sync_status, count(*) from public.academic_live_classes group by 1 order by 1;
