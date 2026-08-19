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
