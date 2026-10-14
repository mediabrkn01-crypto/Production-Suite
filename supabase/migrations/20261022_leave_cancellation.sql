-- HR can cancel an APPROVED leave (any date). The request is never deleted: status → 'cancelled'
-- with who / when / why. Balance is derived from approved requests, so it restores by itself.
-- Safe to re-run.
alter table public.hr_leave_requests
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_by_email  text;
