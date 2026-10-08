-- ════════════════════════════════════════════════════════════════════════════
-- Jarvis (Founder Deck voice assistant) — audit trail + short conversation memory.
--
-- Jarvis is a READ-ONLY voice layer on top of the existing ERP tables. These two tables
-- hold only Jarvis's own records; no business data is copied or changed.
--
--   jarvis_audit_log — one row per interaction: verified user, resolved role, transcript,
--                      tool names + parameters + outcome, success/failure, latency.
--                      Raw microphone audio is never stored.
--   jarvis_turns     — the last few user/assistant texts of a session (follow-up context).
--
-- RLS is enabled with NO policies: the browser (anon / authenticated keys) can neither read
-- nor write these tables. Only the `jarvis` edge function (service role) can. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.jarvis_audit_log (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  auth_user_id   uuid,
  employee_id    uuid,
  email          text,
  role           text,
  scope          text,
  session_id     text,
  input_mode     text,                          -- voice | text
  transcript     text,
  response_text  text,
  language       text,
  tools          jsonb not null default '[]'::jsonb,   -- [{name, args, ok, ms, error}]
  success        boolean not null default false,
  error_code     text,
  stt_ms         integer,
  llm_ms         integer,
  tts_ms         integer,
  total_ms       integer,
  llm_provider   text,
  llm_model      text
);
create index if not exists idx_jarvis_audit_user_time on public.jarvis_audit_log (auth_user_id, created_at desc);
create index if not exists idx_jarvis_audit_time on public.jarvis_audit_log (created_at desc);
alter table public.jarvis_audit_log enable row level security;

create table if not exists public.jarvis_turns (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  auth_user_id  uuid not null,
  session_id    text not null,
  role          text not null check (role in ('user', 'assistant')),
  content       text not null
);
create index if not exists idx_jarvis_turns_session on public.jarvis_turns (auth_user_id, session_id, created_at desc);
alter table public.jarvis_turns enable row level security;

-- Housekeeping: conversation memory is only useful for a couple of hours.
-- (Run manually or schedule with pg_cron:  select cron.schedule('jarvis-turns-gc', '15 3 * * *', $$delete from public.jarvis_turns where created_at < now() - interval '7 days'$$);)
