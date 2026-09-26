-- Applied 2026-09-26 (data change, no schema change).
-- Leave policy version 2: policy go-live 2026-10-01 (LEAVE_SYSTEM_START) — before it no
-- new-policy penalties (approved leave paid, no late/early deductions, no probation/notice LOP).
-- New HR-editable switches: SL_IN_PROBATION=false, CL_IN_PROBATION=false, LEAVE_IN_NOTICE=false.
-- v1 superseded; audit row written to hr_policy_audit. hr_policy_config now also uses
-- status 'scheduled' for future-dated versions (policy-config.js picks the in-force one by date).
with cur as (
  update hr_policy_config set status='superseded', superseded_at=now()
  where policy_key='leave' and status='active' returning id, settings
), nv as (
  insert into hr_policy_config (policy_key, version, settings, effective_date, status, created_by, approved_by, approved_at, notes)
  select 'leave', 2,
    cur.settings || jsonb_build_object('LEAVE_SYSTEM_START','2026-10-01','SL_IN_PROBATION',false,'CL_IN_PROBATION',false,'LEAVE_IN_NOTICE',false),
    current_date, 'active', 'system (policy go-live update)', 'analpbrk@gmail.com', now(),
    'Policy starts 2026-10-01 (no new-policy penalties before). No sick/casual leave during probation; no paid leave during notice. HR-editable switches added.'
  from cur returning id, settings
)
insert into hr_policy_audit (policy_config_id, action, actor_email, prev_settings, new_settings, reason)
select nv.id, 'activated', 'analpbrk@gmail.com', cur.settings, nv.settings, 'Go-live 2026-10-01; probation: no SL/CL; notice: no paid leave'
from nv, cur;
