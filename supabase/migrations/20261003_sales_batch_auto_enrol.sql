-- ════════════════════════════════════════════════════════════════════════════
-- Sales ⇄ Academic upcoming-batch enrollment.
-- Single source of truth stays: batches (published by Academic) + students.batch_id
-- (membership — one batch per student, so duplicates are structurally impossible).
--
--  _be_slot_start_min(text)          first start time in a slot label → minutes
--  batch_candidates_for_student(id)  open upcoming batches the student could join
--  batch_match_for_student(id)       'assigned' | 'single' | 'multiple' | 'time_required' | 'none'
--  enroll_student_in_batch(b, s, override)  + deadline/course checks, Dropped not counted
--  try_auto_assign_student(id)       enrolls only when exactly one batch clearly fits
--  trigger on students: new / re-coursed unassigned students are auto-assigned
-- Dates use Asia/Kolkata.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public._be_slot_start_min(t text)
returns int language plpgsql immutable as $$
declare m text[];
begin
  if t is null then return null; end if;
  m := regexp_match(t, '(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]');
  if m is not null then
    return ((m[1]::int % 12) + case when upper(m[3]) = 'P' then 12 else 0 end) * 60 + coalesce(m[2]::int, 0);
  end if;
  m := regexp_match(t, '(\d{1,2}):(\d{2})');
  if m is not null then return m[1]::int * 60 + m[2]::int; end if;
  return null;
end; $$;

create or replace function public._be_today_ist() returns date language sql stable as
$$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function public.batch_candidates_for_student(p_student_id uuid)
returns table(batch_id uuid, batch_name text, start_date date, enrollment_deadline date, time_slot text,
              trainer_name text, capacity int, enrolled int, needs_time boolean, time_ok boolean)
language sql stable security definer set search_path = public as $$
  with s as (
    select st.*, (select c.id from courses c where lower(c.name) = lower(st.programme) limit 1) as course_id
    from students st where st.id = p_student_id
  ), b as (
    select bt.*, (select count(*) from students x where x.batch_id = bt.id and coalesce(x.status,'') <> 'Dropped')::int as enrolled
    from batches bt, s
    where bt.deleted_at is null and bt.status = 'upcoming' and bt.enrollment_status = 'open'
      and ((s.course_id is not null and bt.course_id = s.course_id)
           or (s.course_id is null and s.programme is not null and lower(bt.programme) = lower(s.programme)))
      and (bt.enrollment_deadline is null or bt.enrollment_deadline >= _be_today_ist())
  )
  select b.id, b.name, b.start_date, b.enrollment_deadline, b.time_slot, b.trainer_name, b.capacity, b.enrolled,
         (coalesce(trim(b.time_slot), '') <> '') as needs_time,
         (coalesce(trim(b.time_slot), '') = '' or (_be_slot_start_min(s.preferred_slot) is not null
            and _be_slot_start_min(s.preferred_slot) = _be_slot_start_min(b.time_slot))) as time_ok
  from b, s
  where coalesce(b.capacity, 0) <= 0 or b.enrolled < b.capacity
  order by b.start_date nulls last, b.name;
$$;

create or replace function public.batch_match_for_student(p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s students%rowtype; v_exact jsonb; v_free jsonb; v_cands jsonb; n_exact int; n_free int; n_timeblocked int;
begin
  select * into s from students where id = p_student_id;
  if not found then return jsonb_build_object('state','none','message','Student not found.'); end if;
  if s.batch_id is not null then return jsonb_build_object('state','assigned','batch_id',s.batch_id); end if;
  if coalesce(s.status,'') = 'Dropped' then return jsonb_build_object('state','none','message','Student is dropped.'); end if;
  select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_cands from batch_candidates_for_student(p_student_id) c;
  -- Exact time matches beat batches without a fixed time; never pick between equals.
  select coalesce(jsonb_agg(e), '[]') into v_exact from jsonb_array_elements(v_cands) e where (e->>'needs_time')::boolean and (e->>'time_ok')::boolean;
  select coalesce(jsonb_agg(e), '[]') into v_free  from jsonb_array_elements(v_cands) e where not (e->>'needs_time')::boolean;
  n_exact := jsonb_array_length(v_exact); n_free := jsonb_array_length(v_free);
  select count(*) into n_timeblocked from jsonb_array_elements(v_cands) e where not (e->>'time_ok')::boolean;
  if n_exact = 1 then return jsonb_build_object('state','single','batch_id',v_exact->0->>'batch_id','candidates',v_cands); end if;
  if n_exact > 1 then return jsonb_build_object('state','multiple','message','Multiple suitable batches found.','candidates',v_exact); end if;
  if n_free = 1 then return jsonb_build_object('state','single','batch_id',v_free->0->>'batch_id','candidates',v_cands); end if;
  if n_free > 1 then return jsonb_build_object('state','multiple','message','Multiple suitable batches found.','candidates',v_free); end if;
  if n_timeblocked > 0 then
    return jsonb_build_object('state','time_required','message',
      case when _be_slot_start_min(s.preferred_slot) is null then 'Time confirmation required.' else 'No batch at the preferred time — pick one manually.' end,
      'candidates',v_cands);
  end if;
  return jsonb_build_object('state','none','message','Batch assignment required — no open batch for this course.');
end; $$;

drop function if exists public.enroll_student_in_batch(uuid, uuid);
create or replace function public.enroll_student_in_batch(p_batch_id uuid, p_student_id uuid, p_override boolean default false)
returns json language plpgsql security definer set search_path = public as $function$
declare
  v_batch batches%rowtype; v_student students%rowtype; v_count int; v_scourse uuid;
begin
  select * into v_batch from batches where id = p_batch_id and deleted_at is null for update;
  if not found then return json_build_object('ok', false, 'error', 'Batch not found'); end if;
  if v_batch.status not in ('upcoming', 'active') then
    return json_build_object('ok', false, 'error', 'Batch is not accepting enrollments (status: ' || coalesce(v_batch.status,'—') || ')');
  end if;
  if coalesce(v_batch.enrollment_status, '') <> 'open' and not (p_override and v_batch.enrollment_status = 'closed') then
    return json_build_object('ok', false, 'error', 'Enrollment is ' || coalesce(v_batch.enrollment_status, 'closed'));
  end if;
  if v_batch.enrollment_deadline is not null and v_batch.enrollment_deadline < _be_today_ist() and not p_override then
    return json_build_object('ok', false, 'error', 'Enrollment deadline has passed (' || v_batch.enrollment_deadline || ')');
  end if;
  select * into v_student from students where id = p_student_id for update;
  if not found then return json_build_object('ok', false, 'error', 'Student not found'); end if;
  if v_student.batch_id = p_batch_id then return json_build_object('ok', false, 'error', 'Student already enrolled in this batch'); end if;
  if coalesce(v_student.status,'') = 'Dropped' then return json_build_object('ok', false, 'error', 'Student is marked Dropped'); end if;
  select c.id into v_scourse from courses c where lower(c.name) = lower(v_student.programme) limit 1;
  if v_batch.course_id is not null and v_scourse is not null and v_scourse <> v_batch.course_id and not p_override then
    return json_build_object('ok', false, 'error', 'Course mismatch: student is on ' || coalesce(v_student.programme,'—') || ', batch is ' || coalesce(v_batch.programme,'—'));
  end if;
  select count(*) into v_count from students where batch_id = p_batch_id and coalesce(status,'') <> 'Dropped';
  if coalesce(v_batch.capacity, 0) > 0 and v_count >= v_batch.capacity then
    update batches set enrollment_status = 'full' where id = p_batch_id and enrollment_status = 'open';
    return json_build_object('ok', false, 'error', 'Batch is full (' || v_count || '/' || v_batch.capacity || ')');
  end if;
  update students set
    batch_id = p_batch_id, batch_name = v_batch.name, trainer_name = v_batch.trainer_name,
    programme = coalesce(v_batch.programme, programme),
    status = case when status in ('New','') or status is null then 'In Progress' else status end
  where id = p_student_id;
  if coalesce(v_batch.capacity, 0) > 0 and (v_count + 1) >= v_batch.capacity then
    update batches set enrollment_status = 'full' where id = p_batch_id and enrollment_status = 'open';
  end if;
  return json_build_object('ok', true, 'enrolled', v_count + 1, 'capacity', v_batch.capacity,
    'full', (coalesce(v_batch.capacity,0) > 0 and (v_count + 1) >= v_batch.capacity), 'batch_name', v_batch.name);
end; $function$;
grant execute on function public.enroll_student_in_batch(uuid, uuid, boolean) to anon, authenticated;

-- Unenroll: Dropped students no longer count against capacity when reopening.
create or replace function public.unenroll_student_from_batch(p_batch_id uuid, p_student_id uuid)
returns json language plpgsql security definer set search_path = public as $function$
declare v_batch batches%rowtype; v_student students%rowtype; v_count int;
begin
  select * into v_batch from batches where id = p_batch_id for update;
  if not found then return json_build_object('ok', false, 'error', 'Batch not found'); end if;
  select * into v_student from students where id = p_student_id;
  if not found or v_student.batch_id is distinct from p_batch_id then
    return json_build_object('ok', false, 'error', 'Student not enrolled in this batch');
  end if;
  update students set batch_id = null, batch_name = null where id = p_student_id;
  select count(*) into v_count from students where batch_id = p_batch_id and coalesce(status,'') <> 'Dropped';
  if v_batch.enrollment_status = 'full' and (coalesce(v_batch.capacity,0) <= 0 or v_count < v_batch.capacity) then
    update batches set enrollment_status = 'open' where id = p_batch_id;
  end if;
  return json_build_object('ok', true, 'enrolled', v_count, 'capacity', v_batch.capacity);
end; $function$;

create or replace function public.try_auto_assign_student(p_student_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m jsonb; r json;
begin
  m := batch_match_for_student(p_student_id);
  if m->>'state' <> 'single' then return m; end if;
  r := enroll_student_in_batch((m->>'batch_id')::uuid, p_student_id, false);
  return m || jsonb_build_object('enrolled', r::jsonb);
end; $$;
grant execute on function public.batch_match_for_student(uuid) to anon, authenticated;
grant execute on function public.batch_candidates_for_student(uuid) to anon, authenticated;
grant execute on function public.try_auto_assign_student(uuid) to anon, authenticated;

-- New student, or an unassigned student whose course / preferred time changed → try once.
create or replace function public.trg_students_auto_assign_batch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.batch_id is not null or coalesce(new.status,'') = 'Dropped' then return new; end if;
  if tg_op = 'UPDATE' and new.programme is not distinct from old.programme
     and new.preferred_slot is not distinct from old.preferred_slot then return new; end if;
  perform try_auto_assign_student(new.id);
  return new;
exception when others then
  return new;   -- auto-assignment must never block saving a student
end; $$;
drop trigger if exists students_auto_assign_batch on public.students;
create trigger students_auto_assign_batch after insert or update of programme, preferred_slot on public.students
  for each row execute function public.trg_students_auto_assign_batch();
