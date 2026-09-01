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
-- BUG FIX, CONFIRMED LIVE against the real production database: academics.html's own
-- savePlan() (Payments tab of the student detail modal) has been upserting discount/
-- discount_by/next_due/note onto this table since it was written — but this original CREATE
-- TABLE never defined those columns, and the real production payments table genuinely only
-- has id/student_id/course_fee/created_at (checked directly via the anon key REST API). A
-- real attempt to save a discount value was reproduced live: PostgREST rejects it outright
-- with "Could not find the 'discount' column of 'payments' in the schema cache" — meaning
-- every discount a Head has ever tried to record has silently failed with no error surfaced
-- in the UI (savePlan()'s own catch only reports actual query failures, and this one fails
-- before the request even reaches Postgres). Additive, safe, no data loss.
alter table payments add column if not exists discount numeric default 0;
alter table payments add column if not exists discount_by text;
alter table payments add column if not exists next_due date;
alter table payments add column if not exists note text;
alter table payments add column if not exists updated_at timestamptz;

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

-- ============================================================================
-- Phase 5 — Production scalability refactor: search indexes + server-side
-- Students pagination. Idempotent, safe to re-run. REQUIRED for the Students
-- tab to actually scale past ~1,000 rows — see academics.html's own
-- loadStudentsTab()/renderStudentsTable() for the frontend half of this.
--
-- CONFIRMED LIVE (load test against a local copy of this schema, 100k
-- synthetic students): a plain B-tree index does NOT speed up `.ilike()` at
-- all — students.trainer_name/.name searches ran a full sequential scan
-- (53-68ms at 100k rows) even with a B-tree index present. Only a GIN index
-- with pg_trgm (trigram matching) actually accelerates a case-insensitive
-- substring search — confirmed dropping the same query to 0.3-3ms once the
-- correct index type was used.
-- ============================================================================
create extension if not exists pg_trgm;

create index if not exists students_name_trgm_idx on students using gin (name gin_trgm_ops);
create index if not exists students_trainer_name_trgm_idx on students using gin (trainer_name gin_trgm_ops);
create index if not exists students_uin_trgm_idx on students using gin (uin gin_trgm_ops);
create index if not exists students_contact_trgm_idx on students using gin (contact gin_trgm_ops);
-- Plain B-tree indexes for the exact-match filters (batch/course/status), which DO benefit
-- from a normal index — only substring/ILIKE search needed the trigram type above.
create index if not exists students_batch_id_idx on students (batch_id);
create index if not exists students_programme_idx on students (programme);
create index if not exists students_status_idx on students (status);
create index if not exists students_enrolled_date_idx on students (enrolled_date);
create index if not exists students_created_at_idx on students (created_at);
-- attendance already has attendance_batch_idx (an earlier phase) — this adds the session_num
-- companion so a count-distinct-sessions-per-batch aggregation (used by the RPC below to
-- compute "is this batch finished" without downloading attendance rows to the browser) can be
-- satisfied from the index alone.
create index if not exists attendance_batch_session_idx on attendance (batch_name, session_num);

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- get_students_page — one SQL call replaces "download the whole students table
-- and filter/sort/paginate it in the browser." Computes each student's real
-- lifecycle status (New/Unassigned/In Progress/Completed/Dropped/On Freeze)
-- from their actual batch assignment and that batch's real progress — the
-- exact same rule academics.html's own _acadStudentLifecycleStatus() already
-- uses client-side — server-side, once per query, not once per row in JS.
--
-- Pagination is OFFSET-based (page/page_size), not cursor/keyset — a
-- deliberate, disclosed scope choice: true keyset pagination across 7
-- different sort modes needs a per-sort-mode cursor encoding scheme, which is
-- meaningfully more complex than this refactor pass covers. OFFSET pagination
-- is the right tradeoff for how this screen is actually browsed (a handful of
-- pages at a time, not deep scrolling through thousands) — the search/filter
-- predicates below are what actually keep any given query fast at scale, same
-- as an e-commerce search page.
-- ----------------------------------------------------------------------------
create or replace function get_students_page(
  p_page int default 1,
  p_page_size int default 50,
  p_search text default null,
  p_status text default null,
  p_batch_id uuid default null,
  p_unassigned_only boolean default false,
  p_course text default null,
  p_trainer_scope text default null,
  p_sort text default 'new_first',
  p_payment text default null
)
returns table (
  id uuid, uin text, name text, contact text, batch_id uuid, batch_name text,
  trainer_name text, programme text, raw_status text, enrolled_date date,
  created_at timestamptz, computed_status text, payment_status text, total_count bigint
)
language sql stable
as $$
  with batch_progress as (
    select b.name as batch_name, b.status as b_status,
           coalesce(b.sessions_total,0) as sessions_total,
           coalesce(b.baseline_sessions,0) + coalesce(a.marked,0) as done
    from batches b
    left join (
      select batch_name, count(distinct session_num) as marked
      from attendance
      group by batch_name
    ) a on a.batch_name = b.name
  ),
  -- Same payment-status rule as academics.html's own _acadStudentPaymentStatus (client-side
  -- resolver, added in an earlier commit): no payments row / fee unset -> None; fee set,
  -- nothing paid -> Pending; paid >= fee-discount -> Paid; partial otherwise.
  pay as (
    select p.student_id,
           coalesce(p.course_fee,0) as fee, coalesce(p.discount,0) as discount,
           coalesce(pe.paid,0) as paid
    from payments p
    left join (select student_id, sum(amount) as paid from payment_entries group by student_id) pe
      on pe.student_id = p.student_id
  ),
  scoped as (
    select s.*,
      case
        when s.status in ('Dropped','On Freeze') then s.status
        when s.batch_id is null then case when s.status = 'New' then 'New' else 'Unassigned' end
        when bp.b_status in ('completed','finished') or (bp.sessions_total > 0 and bp.done >= bp.sessions_total) then 'Completed'
        else 'In Progress'
      end as computed_status,
      case
        when pay.fee is null or pay.fee <= 0 then 'None'
        when pay.paid <= 0 then 'Pending'
        when pay.paid >= greatest(pay.fee - pay.discount, 0) then 'Paid'
        else 'Partial'
      end as payment_status
    from students s
    left join batch_progress bp on bp.batch_name = s.batch_name
    left join pay on pay.student_id = s.id
    where (p_trainer_scope is null or s.trainer_name ilike p_trainer_scope)
  ),
  filtered as (
    select * from scoped
    where (p_search is null or p_search = '' or name ilike '%'||p_search||'%' or uin ilike '%'||p_search||'%' or contact ilike '%'||p_search||'%')
      and (p_status is null or p_status = '' or computed_status = p_status)
      and (p_payment is null or p_payment = '' or payment_status = p_payment)
      and (p_unassigned_only = false or batch_id is null)
      and (p_unassigned_only = true or p_batch_id is null or batch_id = p_batch_id)
      and (p_course is null or p_course = '' or programme = p_course)
  ),
  counted as ( select count(*) as total_count from filtered )
  select f.id, f.uin, f.name, f.contact, f.batch_id, f.batch_name, f.trainer_name, f.programme,
         f.status as raw_status, f.enrolled_date, f.created_at, f.computed_status, f.payment_status,
         c.total_count
  from filtered f, counted c
  order by
    case when p_sort='new_first' then (case when f.computed_status in ('New','Unassigned') then 0 when f.computed_status='In Progress' then 1 else 2 end) end asc nulls last,
    case when p_sort='new_first' or p_sort is null then f.created_at end desc nulls last,
    case when p_sort='oldest_first' then f.created_at end asc nulls last,
    case when p_sort='name_az' then f.name end asc nulls last,
    case when p_sort='name_za' then f.name end desc nulls last,
    case when p_sort='recent' then f.enrolled_date end desc nulls last,
    case when p_sort='batch_az' then f.batch_name end asc nulls last,
    case when p_sort='coach_az' then f.trainer_name end asc nulls last
  limit greatest(p_page_size,1) offset (greatest(p_page,1)-1) * greatest(p_page_size,1);
$$;

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- get_academic_dashboard_summary — the Academic Overview dashboard's own tile
-- row (Total Coaches/Available/Full-Time/Part-Time/Active Batches/Upcoming/
-- Students/Today's Classes/On Leave/Upcoming Availability) currently computes
-- every one of these counts in the BROWSER after downloading full
-- trainers/batches/students tables (loadAcadDashboard() in academics.html).
-- This single RPC returns just the 10 numbers. Wiring academics.html to call
-- it is left for a follow-up pass (disclosed in the refactor report) — this
-- migration ships the function now so it's ready, without changing the
-- dashboard's own behavior in this same commit.
-- ----------------------------------------------------------------------------
create or replace function get_academic_dashboard_summary()
returns table (
  total_coaches bigint, active_batches bigint, upcoming_batches bigint,
  total_students bigint, todays_classes bigint
)
language sql stable
as $$
  select
    (select count(*) from trainers where status = 'active') as total_coaches,
    (select count(*) from batches where status = 'active' and deleted_at is null
       and (expected_completion_date is null or expected_completion_date >= current_date)) as active_batches,
    (select count(*) from batches where deleted_at is null and start_date > current_date) as upcoming_batches,
    (select count(*) from students) as total_students,
    (select count(*) from sessions where session_date = current_date) as todays_classes;
$$;

NOTIFY pgrst, 'reload schema';
