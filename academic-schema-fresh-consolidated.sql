-- ============================================================================
-- Academic module — FULL FRESH SCHEMA, consolidated into the Media Suite
-- project (fevqnpllmarhoqdzpatq). Run this ONCE in that project's SQL Editor.
--
-- Context: academics.html was previously wired to a separate Supabase
-- project (baazubvfsrpmbfmrzumw) that is no longer reachable/managed under
-- the current login. By user decision, that old project's data is NOT being
-- migrated — this creates a brand-new, empty Academic schema in the same
-- project HR/Media Suite already uses (fevqnpllmarhoqdzpatq), and the app
-- code is being repointed here. Existing hr_* tables in this project are
-- untouched by this file.
--
-- Safe to re-run: every statement is "if not exists".
-- ============================================================================

-- ---------- trainers (Academic's mirror of HR's education-division staff) ----------
create table if not exists trainers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',        -- 'active' | 'inactive'
  type text default 'ft',                        -- 'ft' | 'pt'
  portal_email text,                              -- mirrors hr_employees.portal_email, used to match a logged-in trainer to their coach row
  teachable_courses text,                         -- comma-joined course names
  pt_max_classes_per_day integer,
  pt_max_hours numeric,
  pt_available_days text,                         -- comma-joined, e.g. "Mon, Wed, Fri"
  pt_time_start text,                             -- "HH:MM"
  pt_time_end text,
  created_at timestamptz not null default now()
);
create unique index if not exists trainers_name_unique on trainers (lower(name));

-- ---------- courses ----------
create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  type text not null default 'group',             -- 'group' | 'one-on-one' | 'recorded'
  sessions_total integer,
  duration_days integer,
  max_students integer,
  fee numeric,
  default_days text,                              -- comma-joined weekday chips, e.g. "Mon, Wed, Fri"
  mc_day text,                                     -- makeup-class day
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- batches ----------
create table if not exists batches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trainer_id uuid references trainers(id) on delete set null,
  trainer_name text,
  course_id uuid references courses(id) on delete set null,
  programme text,
  day_pattern text,
  time_slot text,
  sessions_total integer,
  baseline_sessions integer,
  capacity integer,
  start_date date,
  expected_completion_date date,
  notes text,
  batch_type text,
  status text not null default 'active',          -- 'active' | 'closed' | ...
  created_at timestamptz not null default now()
);
create unique index if not exists batches_name_unique on batches (lower(name));

-- ---------- students ----------
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  uin text,
  name text not null,
  contact text,
  batch_id uuid references batches(id) on delete set null,
  batch_name text,
  trainer_name text,
  programme text,
  status text default 'In Progress',
  planned_end_date date,
  source_counsellor text,
  enrolled_date date,
  preferred_slot text,
  created_at timestamptz not null default now()
);

-- ---------- attendance (per-student, per-session class attendance — separate from employee hr_attendance) ----------
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  batch_name text,
  student_uin text,
  session_num integer,
  session_date date,
  status text,                                     -- 'present' | 'pending' | 'absent'
  marked_by text,
  created_at timestamptz not null default now()
);
create index if not exists attendance_batch_idx on attendance (batch_name);
create index if not exists attendance_student_idx on attendance (student_uin);

-- ---------- sessions (1:1 / makeup / trial session log, distinct from `attendance`) ----------
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  batch_id uuid references batches(id) on delete set null,
  session_date date,
  type text,
  status text,                                     -- 'completed' | 'scheduled' | ...
  notes text,
  logged_by text,
  created_at timestamptz not null default now()
);

-- ---------- assignments (tasks assigned to a trainer by the Academic Head) ----------
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid references trainers(id) on delete cascade,
  task text,
  due_date date,
  assigned_by text,
  created_at timestamptz not null default now()
);

-- ---------- payments (per-student fee summary, one row per student) ----------
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  course_fee numeric,
  created_at timestamptz not null default now()
);
create unique index if not exists payments_student_unique on payments (student_id);

-- ---------- payment_entries (individual payment transactions) ----------
create table if not exists payment_entries (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  amount numeric,
  paid_at date,
  method text,
  entered_by text,
  created_at timestamptz not null default now()
);

-- ---------- roles (Academic's own username/password login table — manual
-- fallback login, used only if SSO from the Media Suite/HR login doesn't
-- apply). Left EMPTY here on purpose per the fresh-start decision — add rows
-- here only if you need direct (non-SSO) logins into academics.html.
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  name text,
  username text unique,
  password text,
  role text,
  created_at timestamptz not null default now()
);

-- ---------- timeclock (Academic's own clock-in/out — distinct from HR's hr_attendance) ----------
create table if not exists timeclock (
  id uuid primary key default gen_random_uuid(),
  username text,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- trainer_slots (trainer-declared availability + Head-assigned bookings) ----------
create table if not exists trainer_slots (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references trainers(id) on delete cascade,
  slot_date date not null,
  start_time text not null,   -- "HH:MM", 24h
  end_time text not null,
  status text not null default 'available',   -- 'available' | 'booked'
  batch_id uuid references batches(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (trainer_id, slot_date, start_time)
);
create index if not exists trainer_slots_date_idx on trainer_slots (slot_date);
create index if not exists trainer_slots_trainer_idx on trainer_slots (trainer_id);

-- ============================================================================
-- Row Level Security: match the permissive style already used by this
-- project's existing hr_* tables (anon key read/write, app-layer auth) so
-- the app continues to work exactly as before with no login/permission
-- changes. Skip this block if your existing hr_* tables use a stricter policy
-- style and you'd rather match that instead — ask before broadening it.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['trainers','courses','batches','students','attendance','sessions','assignments','payments','payment_entries','roles','timeclock','trainer_slots']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_allow_all', t);
    execute format('create policy %I on %I for all using (true) with check (true)', t || '_allow_all', t);
  end loop;
end $$;

-- Reload PostgREST's schema cache so the new tables are visible immediately.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Phase 2 — Recurring Trainer Availability (replaces trainer_slots' role as
-- the trainer's own "capacity" declaration). Idempotent, safe to re-run.
--
-- trainer_slots (above) was one row per trainer per exact calendar date per
-- hour — a trainer had to re-declare the same working hours every single day,
-- and nothing ever released a slot automatically when a batch finished. This
-- table is the opposite: one row per RECURRING time window a trainer offers,
-- entered once, with no date dimension at all (effective_from/effective_until
-- bound WHEN the declaration itself is in force, not which calendar dates it
-- covers day-by-day). Whether a given window is currently FREE or OCCUPIED is
-- never stored here — it's always computed live from `batches` (which already
-- carries trainer_id/start_date/expected_completion_date/time_slot), the same
-- way it's computed in academics.html's own availability engine. trainer_slots
-- itself is left in place (not dropped) since older rows/other code may still
-- reference it, but the app no longer writes new ones for capacity purposes.
-- ============================================================================
create table if not exists trainer_availability (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references trainers(id) on delete cascade,
  start_time text not null,        -- "HH:MM", 24h — same convention trainer_slots already used
  end_time text not null,
  effective_from date not null default current_date,  -- when this declared window starts applying
  effective_until date,                                 -- nullable = indefinite, until edited/removed
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists trainer_availability_trainer_idx on trainer_availability (trainer_id);

alter table trainer_availability enable row level security;
drop policy if exists trainer_availability_allow_all on trainer_availability;
create policy trainer_availability_allow_all on trainer_availability for all using (true) with check (true);

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Phase 3 — Safe (soft) batch delete. Idempotent, safe to re-run.
--
-- deleteBatch() used to hard-delete the batches row outright, which either
-- failed with an FK error once any student/attendance/session row referenced
-- it, or (for a genuinely empty batch) succeeded but left every reader with
-- no way to distinguish "never existed" from "was deleted on purpose" — and
-- more importantly, gave HR/Academic no way to preserve a completed batch's
-- history while still removing it from every active/upcoming view.
--
-- deleted_at IS NULL means the batch is live (same as every existing query's
-- current behavior, since this column doesn't exist for any row until this
-- migration runs — the app's own client-side checks already treat a missing
-- deleted_at exactly the same as a null one, so nothing breaks before this
-- is applied, it just means Delete Batch doesn't fully take effect yet).
-- ============================================================================
alter table batches add column if not exists deleted_at timestamptz;
create index if not exists batches_deleted_at_idx on batches (deleted_at);

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Phase 4 — Enable Supabase Realtime on the Academic module's own tables.
-- Idempotent, safe to re-run. REQUIRED for academics.html's realtime sync
-- layer (_acadInitRealtime) to receive any live events at all.
--
-- Live-tested against the actual project (fevqnpllmarhoqdzpatq) BEFORE this
-- migration: a real subscribed postgres_changes channel on `batches` and on
-- `students` received ZERO events after real, confirmed-200 UPDATEs on real
-- rows — proving these tables were never added to the supabase_realtime
-- publication (the anon key can open a Realtime websocket and get
-- SUBSCRIBED, since that only needs the publication to exist, but no table
-- ever emits an event until it's explicitly added to it). This has nothing
-- to do with RLS or the anon key's permissions — it's a project-level
-- setting only a migration with elevated (non-anon) access can change, so it
-- could not be applied directly and must be run once, manually, the same way
-- every other Phase in this file already is.
--
-- ADD TABLE is a no-op (with a harmless notice, not an error) if a table is
-- already published — safe to re-run this whole block.
-- ============================================================================
alter publication supabase_realtime add table batches;
alter publication supabase_realtime add table attendance;
alter publication supabase_realtime add table students;
alter publication supabase_realtime add table trainer_availability;

-- REPLICA IDENTITY FULL so DELETE/UPDATE payloads carry the full OLD row
-- (default identity only sends the primary key) — the realtime layer's own
-- refresh is a blanket refetch either way, not a payload-driven DOM patch,
-- so this isn't load-bearing for academics.html today, but it's what lets a
-- future consumer (or Supabase's own dashboard/logs) see full before/after
-- values on these tables instead of just an id.
alter table batches replica identity full;
alter table attendance replica identity full;
alter table students replica identity full;
alter table trainer_availability replica identity full;
