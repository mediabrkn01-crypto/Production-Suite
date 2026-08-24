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
