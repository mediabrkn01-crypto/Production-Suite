-- Applied 2026-09-24. attendance.session_num is derived from class dates, never trusted from the client.
-- Rule (matches live progress): legacy undated present sessions count first; then each dated day in
-- order — a day with any Present = next completed number; an all-absent day = the number still owed.

create or replace function public.fn_renumber_attendance(p_batch text)
returns void language plpgsql as $$
declare v_base int;
begin
  if p_batch is null then return; end if;
  select count(distinct session_num) into v_base from public.attendance
   where batch_name = p_batch and session_date is null and status = 'present';
  with d as (
    select session_date, bool_or(status = 'present') done
    from public.attendance
    where batch_name = p_batch and session_date is not null
    group by session_date
  ), n as (
    select session_date, done,
      v_base + count(*) filter (where done) over (order by session_date rows between unbounded preceding and current row) cdone
    from d
  )
  update public.attendance a
     set session_num = case when n.done then n.cdone else n.cdone + 1 end
    from n
   where a.batch_name = p_batch
     and a.session_date = n.session_date
     and a.session_num is distinct from (case when n.done then n.cdone else n.cdone + 1 end);
end $$;

create or replace function public.fn_attendance_renumber_stmt()
returns trigger language plpgsql as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    for r in select distinct batch_name from new_rows loop perform public.fn_renumber_attendance(r.batch_name); end loop;
  elsif tg_op = 'DELETE' then
    for r in select distinct batch_name from old_rows loop perform public.fn_renumber_attendance(r.batch_name); end loop;
  end if;
  return null;
end $$;

create or replace function public.fn_attendance_renumber_row()
returns trigger language plpgsql as $$
begin
  perform public.fn_renumber_attendance(new.batch_name);
  if old.batch_name is distinct from new.batch_name then perform public.fn_renumber_attendance(old.batch_name); end if;
  return null;
end $$;

drop trigger if exists trg_attendance_renumber_ins on public.attendance;
create trigger trg_attendance_renumber_ins after insert on public.attendance
  referencing new table as new_rows for each statement execute function public.fn_attendance_renumber_stmt();
drop trigger if exists trg_attendance_renumber_del on public.attendance;
create trigger trg_attendance_renumber_del after delete on public.attendance
  referencing old table as old_rows for each statement execute function public.fn_attendance_renumber_stmt();
drop trigger if exists trg_attendance_renumber_upd on public.attendance;
create trigger trg_attendance_renumber_upd after update of status, session_date, batch_name on public.attendance
  for each row execute function public.fn_attendance_renumber_row();

-- One-time correction of existing data.
select public.fn_renumber_attendance(batch_name) from (select distinct batch_name from public.attendance where batch_name is not null) b;
