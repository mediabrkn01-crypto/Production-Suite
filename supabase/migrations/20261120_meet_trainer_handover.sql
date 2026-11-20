-- Trainer reassignment → Google Meet handover state (2026-11-20).
--
-- Changing a batch's trainer does not change who hosts its existing Google Meets — each Meet
-- lives in its organizer's Google account. The Academic team now decides per reassignment
-- (Update Google Meet Setup / Keep Existing / Cancel) and the decision + outcome is stored per
-- class so the background queue can finish it (e.g. once the new trainer connects Google) and
-- never silently replaces a Meet the team chose to keep.
--
--   meet_handover_status  null | update_required | update_requested | manual_required | kept | done | failed
--   meet_handover_error   readable reason shown in Live Classes
--
-- Additive only; the academic-meet function works without these columns (it skips them).

alter table public.academic_live_classes
  add column if not exists meet_handover_status text,
  add column if not exists meet_handover_error text;

alter table public.academic_live_classes
  drop constraint if exists academic_live_classes_meet_handover_status_chk;
alter table public.academic_live_classes
  add constraint academic_live_classes_meet_handover_status_chk
  check (meet_handover_status is null or meet_handover_status in
    ('update_required', 'update_requested', 'manual_required', 'kept', 'done', 'failed'));

create index if not exists academic_live_classes_handover_idx
  on public.academic_live_classes (meet_handover_status, class_date)
  where meet_handover_status in ('update_requested', 'manual_required');
