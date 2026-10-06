-- ════════════════════════════════════════════════════════════════════════════
-- Payroll day snapshot — the payslip prints the SAME day counts the money was built on.
--
-- hr_payroll.day_breakdown (jsonb) is written by Generate Payroll / Recalculate / Save
-- with the attendance figures used for that calculation, e.g.
--   { "basis": 30, "days_in_month": 31, "present": 22, "paid_leave": 1, "weekly_off": 5,
--     "holiday": 2, "official_event": 0, "half_day": 0, "absent": 1, "leave_lop": 0,
--     "incident_days": 0, "double_days": 0, "lop_days": 1, "pre_joining": 0, ... }
-- Before this column exists the app keeps working: saves skip it and the payslip falls
-- back to a live calculation (the old behaviour). Rows saved earlier get it on their next
-- Generate / Recalculate. Sent payslips are never recalculated.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_payroll
  add column if not exists day_breakdown jsonb;

comment on column public.hr_payroll.day_breakdown is
  'Attendance day counts payroll was calculated from (30-day salary basis). Written by HR payroll; read by the payslip.';
