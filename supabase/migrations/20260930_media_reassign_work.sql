-- Media Head → own-team reassignment of a work item (same assignments row, same id).
-- Only assigned_to / employee_email change; every rule is re-checked here.
create or replace function public.media_reassign_work(p_assignment_id bigint, p_actor_email text, p_new_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  hr_employees%rowtype;
  v_target hr_employees%rowtype;
  v_task   assignments%rowtype;
  v_name   text;
begin
  select * into v_actor from hr_employees
   where lower(portal_email) = lower(trim(p_actor_email))
     and system_role = 'media_head' and employment_status = 'active'
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'Only the Media Head can reassign work.'); end if;

  select * into v_task from assignments where id = p_assignment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'This work no longer exists.'); end if;
  if lower(coalesce(v_task.employee_email, '')) <> lower(v_actor.portal_email) then
    return jsonb_build_object('ok', false, 'error', 'This work is no longer assigned to you.');
  end if;
  if v_task.status not in ('Pending', 'In Progress', 'Rework Required') or coalesce(v_task.manager_approved, false) or v_task.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'error', 'Only work that is pending, in progress or in rework can be reassigned.');
  end if;

  select * into v_target from hr_employees
   where lower(portal_email) = lower(trim(p_new_email)) limit 1;
  if not found or v_target.employment_status <> 'active' or coalesce(v_target.account_type, 'employee') <> 'employee'
     or v_target.division is distinct from v_actor.division or v_target.id = v_actor.id then
    return jsonb_build_object('ok', false, 'error', 'That person is not an active member of your team.');
  end if;
  if v_target.portal_access_enabled = false then
    return jsonb_build_object('ok', false, 'error', 'That person''s sign-in is turned off, so they can''t receive work.');
  end if;

  select coalesce((select nullif(u.name, '') from user_roster u where lower(u.email) = lower(v_target.portal_email) limit 1), v_target.full_name)
    into v_name;

  update assignments
     set assigned_to = v_name, employee_email = lower(v_target.portal_email)
   where id = p_assignment_id;

  insert into hr_audit_log (employee_id, actor_email, actor_name, action, entity, prev_status, new_status, meta)
  values (v_target.id, lower(v_actor.portal_email), v_actor.full_name, 'work_reassigned', 'assignment',
          v_task.status, v_task.status,
          jsonb_build_object('assignment_id', p_assignment_id, 'topic', v_task.topic,
                             'previous_assignee', v_task.assigned_to, 'previous_email', v_task.employee_email,
                             'new_assignee', v_name, 'new_email', lower(v_target.portal_email),
                             'reassigned_by', v_actor.full_name, 'reassigned_at', now()));

  return jsonb_build_object('ok', true, 'assigned_to', v_name, 'employee_email', lower(v_target.portal_email));
end;
$$;
grant execute on function public.media_reassign_work(bigint, text, text) to anon, authenticated;
