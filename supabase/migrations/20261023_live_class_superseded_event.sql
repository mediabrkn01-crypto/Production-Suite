-- ════════════════════════════════════════════════════════════════════════════
-- Live Classes — moving a class to the trainer's own Google account.
--
-- superseded_event: the OLD Calendar event (made by Classes BRK) still to be cancelled after the
-- class was re-created in the trainer's account — kept when Google was limiting Classes BRK at
-- that moment, so the queue cancels it later and students are never left with two events.
--   { "calendar_id": "...", "event_id": "...", "kind": "fallback" | "trainer",
--     "employee_id": "..." | null, "meet_url": "..." }
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.academic_live_classes
  add column if not exists superseded_event jsonb;

create index if not exists idx_alc_superseded on public.academic_live_classes ((superseded_event is not null))
  where superseded_event is not null;

-- Check
select count(*) filter (where google_organizer_kind = 'fallback') as fallback_classes,
       count(*) filter (where google_organizer_kind = 'trainer')  as trainer_classes
  from public.academic_live_classes where class_date >= current_date;
