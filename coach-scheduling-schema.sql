-- Coach profile & scheduling fields — Phase 1 (Coach profiles + course assignment)
-- Run this ONCE in each Supabase project's SQL editor:
--   1. The Media Suite project (fevqnpllmarhoqdzpatq) — adds columns to hr_employees.
--   2. The Academic project (baazubvfsrpmbfmrzumw) — adds the same columns to trainers,
--      which is what batches/schedules actually foreign-key against.
-- Idempotent: safe to re-run. Existing employees/trainers are unaffected — new columns
-- default to NULL, meaning "not a Coach / not configured yet", not an error.

-- ============ Run in the MEDIA SUITE project (fevqnpllmarhoqdzpatq) ============
alter table hr_employees add column if not exists employment_type text;              -- 'full_time' | 'part_time'
alter table hr_employees add column if not exists teachable_courses text;            -- comma-joined course names (matches the existing `department` roles convention)
alter table hr_employees add column if not exists pt_max_classes_per_day integer;
alter table hr_employees add column if not exists pt_max_hours numeric;
alter table hr_employees add column if not exists pt_available_days text;            -- comma-joined, e.g. "Mon, Wed, Fri"
alter table hr_employees add column if not exists pt_time_start text;                -- "HH:MM", stored as text to match the <input type="time"> value directly
alter table hr_employees add column if not exists pt_time_end text;

-- ============ Run in the ACADEMIC project (baazubvfsrpmbfmrzumw) ============
alter table trainers add column if not exists teachable_courses text;
alter table trainers add column if not exists pt_max_classes_per_day integer;
alter table trainers add column if not exists pt_max_hours numeric;
alter table trainers add column if not exists pt_available_days text;
alter table trainers add column if not exists pt_time_start text;
alter table trainers add column if not exists pt_time_end text;
-- Note: trainers.type already exists ('ft'/'pt') from the original schema — HR's
-- employment_type ('full_time'/'part_time') is mapped onto it by acadSyncTrainersFromHR(),
-- no new column needed for that one.

-- Batch Management fields (academics.html) — Expected Completion Date + Notes, and a
-- uniqueness constraint on batch name (the app already checks for a duplicate before
-- inserting; this is the database-level backstop for the same rule).
alter table batches add column if not exists expected_completion_date date;
alter table batches add column if not exists notes text;
create unique index if not exists batches_name_unique on batches (lower(name));

-- ============ Phase 2 addition — Academic Dashboard redesign ============
-- Run in the ACADEMIC project (baazubvfsrpmbfmrzumw). Safe to re-run the whole file again;
-- every statement above is already idempotent.
alter table trainers add column if not exists portal_email text;         -- mirrored from hr_employees, lets leaves.username (an email when signed in via the Media Suite) match a trainer reliably for On Leave / availability lookups

-- ============ Phase 3 — Real time-slot scheduling (Trainer Availability + Booking) ============
-- Run in the ACADEMIC project (baazubvfsrpmbfmrzumw).
-- One row = one fixed 1-hour slot for one trainer on one date. A trainer creates a row to
-- mark themselves available; the Academic Head "books" that same row (sets status +
-- batch_id) to assign a class into it — never a second, separate booking record, so a slot
-- cannot be double-booked: booking is just updating the one row that already represents it,
-- and the app only offers slots with status='available' as assignable in the first place.
create table if not exists trainer_slots (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references trainers(id) on delete cascade,
  slot_date date not null,
  start_time text not null,   -- "HH:MM", 24h, matches <input type="time"> directly
  end_time text not null,
  status text not null default 'available',   -- 'available' | 'booked'
  batch_id uuid references batches(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (trainer_id, slot_date, start_time)   -- one row per trainer per slot — the hard
                                                -- backstop against double-booking, not just
                                                -- an app-level check
);
create index if not exists trainer_slots_date_idx on trainer_slots (slot_date);
create index if not exists trainer_slots_trainer_idx on trainer_slots (trainer_id);

-- ============ Phase 4 — Flexible multi-range working hours (Trainer/Coach) ============
-- Run in the MEDIA SUITE project (fevqnpllmarhoqdzpatq). Idempotent, safe to re-run.
-- Some Trainers/Coaches don't work one continuous block (e.g. 10:00-12:00, 14:00-16:00,
-- 18:00-19:00 in the same day) — the old pt_time_start/pt_time_end pair could only ever
-- hold one range. pt_time_ranges stores that as JSON text: a list of {"start":"HH:MM",
-- "end":"HH:MM"} objects, e.g. '[{"start":"10:00","end":"12:00"},{"start":"14:00","end":"16:00"}]'.
-- Optional — NULL/empty means "not set", same as every other pt_* field, and a record can
-- still be saved with none. pt_time_start/pt_time_end are kept as-is (not dropped) so
-- already-saved single-range records keep displaying correctly via hrGetWorkingHourRanges()'s
-- fallback (common.js) — new saves from hr.html write pt_time_ranges (and, for backward
-- compatibility with anything still reading the old pair, mirror the first/last range's
-- start/end into pt_time_start/pt_time_end too).
alter table hr_employees add column if not exists pt_time_ranges text;
alter table trainers add column if not exists pt_time_ranges text;

-- No new table for student attendance — an `attendance` table (student_uin/batch_name/
-- session_num/session_date/status/marked_by), already independent of employee attendance,
-- already existed from before this phase (see openAtt()/saveAtt() in academics.html, on the
-- Batches tab). Reusing it, not duplicating it, is the correct fix — see the app-code commit
-- for what actually needed to change (propagating the newly assigned trainer onto the
-- batch's students so they show up there).

-- ============ Phase 5 — Legacy vs new course structure, per batch ============
-- Run in the ACADEMIC project (fevqnpllmarhoqdzpatq, same consolidated project). Idempotent.
-- The 2026 course-structure change (e.g. Foundation: old 32 group + 8 master + 2 one-on-one
-- -> new 40 group + 0 master + 2 one-on-one) does NOT rename the course — "Foundation",
-- "Talk Club Elite", and "Elite Course" are each ONE course row shared by both the batches
-- that already exist under the old structure and any new batch created after the change.
-- The distinction lives on the BATCH, not a duplicate course record: batch_structure_version
-- is 'legacy' for a batch created under the old session composition, 'new_2026' for one
-- created after. Never inferred/recomputed automatically from the course name — set once,
-- at batch-creation time, and never changed afterward, so an ongoing legacy batch is never
-- silently reinterpreted under the new session composition (see Academic Existing-Data
-- Migration spec: "Never automatically convert an ongoing legacy batch into the new
-- structure."). NULL means "not set" (e.g. a batch created before this column existed) —
-- treat that the same as 'legacy' when displaying/continuing an existing batch's session
-- count, since it predates the new structure entirely.
alter table batches add column if not exists batch_structure_version text;

-- ============ Phase 6 — Attendance session type (group / one-on-one / masterclass) ============
-- Run in the ACADEMIC project (fevqnpllmarhoqdzpatq, same consolidated project). Idempotent.
-- The live single-track attendance flow (openAtt()/saveAtt() in academics.html) has always
-- had one session_num counter per batch, with no notion of "which kind of session" — fine
-- when a batch only ever has one class stream. The Academic Existing-Data Migration needs
-- more: a legacy Foundation-structure batch tracks THREE independent numbered series in the
-- same period — Group Session #1, One-on-One #1, Masterclass #1 are three different classes,
-- not the same one. Without a type column those would collide as indistinguishable duplicate
-- rows under the same session_num. session_type is nullable and NOT set by the existing live
-- saveAtt() flow — untyped/NULL rows (everything marked day-to-day through the app, before and
-- after this migration) are implicitly "the batch's one class stream", same meaning as today;
-- only rows written by the legacy-data migration set it explicitly.
alter table attendance add column if not exists session_type text;

-- ============ Phase 7 — Temporary Academic Head delegation ============
-- Run in the ACADEMIC project (fevqnpllmarhoqdzpatq, same consolidated project). Idempotent.
-- Lets an Academic Head hand off Head-level access to a specific Trainer/Coach for a
-- specific time window (e.g. while on leave) WITHOUT changing that Trainer's actual role —
-- hr_employees/trainers.role is never touched by this feature at all; "is this person
-- currently an effective Head" is always computed live from this table (does an active,
-- non-revoked row exist whose window contains right now), never stored as a flag on the
-- trainer/employee record itself. That's what makes expiry automatic: once now() passes
-- end_datetime, the row simply stops matching that live query — no cron/backend job, no
-- separate "expire" write needed. status distinguishes an explicit early revoke from a
-- delegation that's merely outside its own time window (both read as "not currently active"
-- to every permission check, but only 'revoked' means a Head deliberately cut it short).
create table if not exists academic_head_delegations (
  id uuid primary key default gen_random_uuid(),
  academic_head_employee_id uuid,          -- hr_employees.id of the delegating Head
  academic_head_name text,                 -- denormalized for display, same convention batches.trainer_name already uses alongside trainer_id
  delegate_trainer_id uuid references trainers(id) on delete cascade,
  delegate_name text,
  start_datetime timestamptz not null,
  end_datetime timestamptz not null,
  status text not null default 'active',   -- 'active' | 'revoked' — see comment above; NOT 'expired' (that's derived from end_datetime, not stored)
  notes text,
  created_by text,                         -- the real Head's own login, so a delegated trainer can never be mistaken for having created it
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists academic_head_delegations_delegate_idx on academic_head_delegations (delegate_trainer_id, status, start_datetime, end_datetime);

-- Academic-only audit trail for delegation create/revoke — deliberately not the old
-- app-wide "Recent Activity" panel (see spec: "Do not reintroduce the old global Recent
-- Activity panel"), just this one feature's own history.
create table if not exists academic_delegation_audit (
  id uuid primary key default gen_random_uuid(),
  delegation_id uuid references academic_head_delegations(id) on delete cascade,
  action text not null,   -- 'created' | 'revoked'
  actor text,
  detail text,
  created_at timestamptz not null default now()
);

-- ============ Phase 8 — Official Event / Paid Special Day (HR Attendance) ============
-- Run in the MEDIA SUITE project (fevqnpllmarhoqdzpatq, same consolidated project). Idempotent.
-- A structured, HR-created record for a company-wide (or department-specific) paid event day
-- where normal clock-in isn't expected — e.g. Onam Celebration, Annual Event, Training Day.
-- Deliberately separate from hr_holidays (Holiday stays 'H', this resolves to 'OE') and NEVER
-- derived from hr_announcements text — HR must explicitly create a row here; nothing in the
-- app scans announcement titles to infer attendance rules (see hrOfficialEventFor in
-- common.js). hrAttDayCode/hrCalculatePayrollForMonth read this table live, so once a row is
-- created, every past date it covers automatically re-resolves from Absent to OE the next
-- time the Attendance Report or Payroll is opened — no per-employee backfill needed.
create table if not exists hr_official_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  title text not null,
  applies_to text not null default 'all',  -- 'all' | 'production' | 'education' | 'sales' | 'hr' | 'accounts' | 'other' — matches hr_employees.division
  paid boolean not null default true,               -- default paid/non-absence, per spec item 12
  clock_in_required boolean not null default false, -- if true, this event changes nothing — normal attendance rules still apply (spec item 11)
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists hr_official_events_date_idx on hr_official_events (event_date, applies_to);
