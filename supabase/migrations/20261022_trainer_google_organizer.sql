-- ════════════════════════════════════════════════════════════════════════════
-- Live Classes — the assigned TRAINER owns the Google Calendar event + Meet.
--
-- employee_google_connections: one Google account per employee, connected once by the
-- trainer through Google OAuth (Academic → Live Classes → Google Meet account). Stores NO
-- password; the refresh token is AES-GCM encrypted by the academic-meet edge function with
-- the GOOGLE_TOKEN_ENC_KEY secret. RLS on with NO policies: only the server (service role)
-- can read or write it — the browser never sees a token.
--
-- academic_live_classes: who owns each class meeting —
--   google_organizer_kind         'trainer' (trainer's own Google account) | 'fallback' (Classes BRK)
--   google_organizer_employee_id  hr_employees.id of the owning trainer (trainer kind)
--   google_organizer_email        organizer address as returned by Google
-- Existing rows (made by the central account) are 'fallback'.
-- Per-account Google limit pause lives on the connection row (paused_until / pause_level).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.employee_google_connections (
  id                       uuid primary key default gen_random_uuid(),
  employee_id              uuid not null unique,          -- hr_employees.id
  trainer_id               uuid,                          -- trainers.id (convenience)
  google_email             text not null,
  google_user_id           text,
  refresh_token_encrypted  text not null,
  scopes                   text,
  connected_at             timestamptz not null default now(),
  connected_by             text,
  last_refresh_at          timestamptz,
  connection_status        text not null default 'connected' check (connection_status in ('connected', 'revoked', 'error')),
  last_error               text,
  paused_until             timestamptz,
  pause_level              integer not null default 0,
  updated_at               timestamptz not null default now()
);
create index if not exists idx_egc_trainer on public.employee_google_connections (trainer_id);

alter table public.employee_google_connections enable row level security;
-- (intentionally no policies — server-only table)
revoke all on public.employee_google_connections from anon, authenticated;

alter table public.academic_live_classes
  add column if not exists google_organizer_kind        text,
  add column if not exists google_organizer_employee_id uuid,
  add column if not exists google_organizer_email       text;

update public.academic_live_classes
   set google_organizer_kind = 'fallback'
 where google_organizer_kind is null and google_calendar_event_id is not null;

do $$ begin
  alter table public.academic_live_classes add constraint alc_organizer_kind_chk check (google_organizer_kind is null or google_organizer_kind in ('trainer', 'fallback'));
exception when duplicate_object then null; end $$;

-- Check
select count(*) as connections from public.employee_google_connections;
