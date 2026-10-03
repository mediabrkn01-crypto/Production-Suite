-- ════════════════════════════════════════════════════════════════════════════
-- Auto-enrol obvious matches from the BATCH side too (follows 20261003_sales_batch_auto_enrol).
-- When a batch is published / reopened / gets more capacity / changes deadline, time or
-- course, every unassigned student of that course whose single clear match
-- (batch_match_for_student = 'single') is a batch gets enrolled — oldest enrolment first,
-- one seat at a time through enroll_student_in_batch (row lock + capacity check), so a batch
-- is never overbooked. Students with several equal options, a time to confirm, or no seat
-- stay unassigned for Sales to decide.
-- Also: 'full' state when the course's batches are full, and a one-time run for the
-- batches that are open right now.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.auto_assign_for_batch(p_batch_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare b batches%rowtype; r record; m jsonb; res json; n int := 0;
begin
  select * into b from batches where id = p_batch_id and deleted_at is null;
  if not found or b.status <> 'upcoming' or b.enrollment_status <> 'open' then return 0; end if;
  for r in
    select s.id from students s
     where s.batch_id is null and coalesce(s.status,'') <> 'Dropped'
       and ((b.course_id is not null and exists (select 1 from courses c where c.id = b.course_id and lower(c.name) = lower(s.programme)))
            or (b.course_id is null and lower(s.programme) = lower(b.programme)))
     order by s.enrolled_date nulls last, s.created_at nulls last, s.id
  loop
    m := batch_match_for_student(r.id);
    if m->>'state' = 'single' and (m->>'batch_id')::uuid = p_batch_id then
      res := enroll_student_in_batch(p_batch_id, r.id, false);
      if (res->>'ok')::boolean then n := n + 1;
      elsif coalesce(res->>'error','') ilike '%full%' then exit;
      end if;
    end if;
  end loop;
  return n;
end; $$;
grant execute on function public.auto_assign_for_batch(uuid) to anon, authenticated;

create or replace function public.trg_batches_auto_assign()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is not null or new.status <> 'upcoming' or new.enrollment_status <> 'open' then return new; end if;
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.enrollment_status is not distinct from new.enrollment_status
     and coalesce(new.capacity,0) <= coalesce(old.capacity,0)
     and old.enrollment_deadline is not distinct from new.enrollment_deadline
     and old.time_slot is not distinct from new.time_slot
     and old.course_id is not distinct from new.course_id then
    return new;
  end if;
  perform auto_assign_for_batch(new.id);
  return new;
exception when others then
  return new;   -- never block saving a batch
end; $$;
drop trigger if exists batches_auto_assign on public.batches;
create trigger batches_auto_assign after insert or update of status, enrollment_status, capacity, enrollment_deadline, time_slot, course_id on public.batches
  for each row execute function public.trg_batches_auto_assign();

-- Distinguish "this course's batches are all full" from "no batch for this course".
create or replace function public.batch_match_for_student(p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s students%rowtype; v_exact jsonb; v_free jsonb; v_cands jsonb; n_exact int; n_free int; n_timeblocked int; v_course uuid;
begin
  select * into s from students where id = p_student_id;
  if not found then return jsonb_build_object('state','none','message','Student not found.'); end if;
  if s.batch_id is not null then return jsonb_build_object('state','assigned','batch_id',s.batch_id); end if;
  if coalesce(s.status,'') = 'Dropped' then return jsonb_build_object('state','none','message','Student is dropped.'); end if;
  select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_cands from batch_candidates_for_student(p_student_id) c;
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
  select c.id into v_course from courses c where lower(c.name) = lower(s.programme) limit 1;
  if exists (select 1 from batches b where b.deleted_at is null and b.status = 'upcoming'
               and b.enrollment_status in ('open','full')
               and (b.enrollment_deadline is null or b.enrollment_deadline >= _be_today_ist())
               and ((v_course is not null and b.course_id = v_course) or (v_course is null and lower(b.programme) = lower(s.programme)))) then
    return jsonb_build_object('state','full','message','Batch full — waiting for an available batch.');
  end if;
  return jsonb_build_object('state','none','message','Batch assignment required — no open batch for this course.');
end; $$;

-- One-time: place today's obvious matches into the batches that are open right now.
do $$ declare r record; begin
  for r in select id from batches where deleted_at is null and status = 'upcoming' and enrollment_status = 'open' order by start_date nulls last loop
    perform auto_assign_for_batch(r.id);
  end loop;
end $$;
