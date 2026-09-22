-- Fix get_available_trainers RPC:
-- 1. Require trainer_availability.days to be non-null (day-less "Needs Days" slots don't qualify)
-- 2. Check requested weekdays (p_days) against the AVAILABILITY slot's days, not just batch conflicts
-- 3. Exclude 'frozen' batches from conflict check (matches freeze/resume feature)

CREATE OR REPLACE FUNCTION public.get_available_trainers(
  p_start_time text,
  p_duration_minutes integer DEFAULT 60,
  p_days text[] DEFAULT NULL::text[],
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_course text DEFAULT NULL::text,
  p_trainer_id uuid DEFAULT NULL::uuid,
  p_exclude_batch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE
AS $function$
  with req as (
    select (split_part(p_start_time,':',1)::int*60 + split_part(p_start_time,':',2)::int) as start_min,
           (split_part(p_start_time,':',1)::int*60 + split_part(p_start_time,':',2)::int) + coalesce(p_duration_minutes,60) as end_min
  ),
  batch_progress as (
    select b.id, b.trainer_id, b.day_pattern, b.time_slot, b.status, b.deleted_at, b.completed_at, b.start_date,
           b.expected_completion_date, b.class_duration_minutes, b.programme,
           coalesce(b.day_pattern, c.default_days) as effective_day_pattern,
           coalesce(b.sessions_total,0) as sessions_total,
           coalesce(b.baseline_sessions,0) + coalesce(a.marked,0) as done
    from batches b
    left join courses c on c.id = b.course_id
    left join (select batch_name, count(distinct session_num) as marked from attendance group by batch_name) a
      on a.batch_name = b.name
  ),
  active_batches as (
    select * from batch_progress
    where deleted_at is null
      and completed_at is null
      and status not in ('inactive','completed','finished','closed','cancelled','archived','frozen')
      and not (sessions_total > 0 and done >= sessions_total)
  ),
  already_teaching as (
    select distinct trainer_id from batches where programme = p_course and trainer_id is not null
  )
  select t.id, t.name
  from trainers t, req r
  where t.status = 'active'
    and (p_trainer_id is null or t.id = p_trainer_id)
    and (
      p_course is null or t.teachable_courses is null or t.teachable_courses = ''
      or t.teachable_courses ilike '%'||p_course||'%'
      or exists (select 1 from already_teaching at where at.trainer_id = t.id)
    )
    and exists (
      select 1 from trainer_availability ta
      where ta.trainer_id = t.id and ta.is_active = true
        and ta.days is not null and ta.days <> ''
        and (split_part(ta.start_time,':',1)::int*60 + split_part(ta.start_time,':',2)::int) <= r.start_min
        and (split_part(ta.end_time,':',1)::int*60 + split_part(ta.end_time,':',2)::int) >= r.end_min
        and (p_days is null or array_length(p_days,1) is null or exists (
              select 1 from unnest(p_days) d where ta.days ilike '%'||d||'%'
            ))
    )
    and not exists (
      select 1 from active_batches ab
      where ab.trainer_id = t.id
        and (p_exclude_batch_id is null or ab.id <> p_exclude_batch_id)
        and (p_days is null or array_length(p_days,1) is null or exists (
              select 1 from unnest(p_days) d where ab.effective_day_pattern ilike '%'||d||'%'
            ))
        and coalesce(ab.start_date,'0001-01-01'::date) <= coalesce(p_end_date,'9999-12-31'::date)
        and coalesce(p_start_date,'0001-01-01'::date) <= coalesce(ab.expected_completion_date,'9999-12-31'::date)
        and _be_parse_time_minutes(ab.time_slot) is not null
        and r.start_min < (_be_parse_time_minutes(ab.time_slot) + coalesce(ab.class_duration_minutes,60))
        and _be_parse_time_minutes(ab.time_slot) < r.end_min
    )
  order by t.name;
$function$;
