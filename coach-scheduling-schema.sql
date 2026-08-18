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
