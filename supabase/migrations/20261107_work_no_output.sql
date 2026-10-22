-- ════════════════════════════════════════════════════════════════════════════
-- WORK COMPLETION — "No Output" chosen by the EMPLOYEE at completion time (nothing to upload:
-- e.g. "Sent the video to Afzal on WhatsApp", "Posted today's WhatsApp status").
--   assignments.no_output         true when completed without a file / link deliverable
--   assignments.completion_note   optional note written when completing
--   assignments.completion_proof  optional proof (screenshot / file) "name|url;;…"
-- Assignment creation is unchanged. Approval logic is unchanged (Media work still goes to Work
-- Approvals). Until this runs, the same facts are kept in history + explanation. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.assignments add column if not exists no_output        boolean not null default false;
alter table public.assignments add column if not exists completion_note  text;
alter table public.assignments add column if not exists completion_proof text;
