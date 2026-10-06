-- ════════════════════════════════════════════════════════════════════════════
-- One atomic, idempotent Clock In / Clock Out for every portal (be-shell.js BEClock).
--
--   select public.be_clock(p_email, p_kind, p_request_id)
--     p_kind        'in' | 'out' | 'status'
--     p_request_id  uuid made once per tap — the same id sent again (retry after a timeout,
--                   a double tap, two tabs) returns the stored first result, never a 2nd action.
--   returns json  { result, state, log_date, log_in_time, log_out_time }
--     result: 'ok' | 'already_in' | 'completed' | 'no_session' | 'status'
--     state : 'none' | 'in' | 'done'
--
-- The employee's day row is locked (FOR UPDATE / advisory lock) so concurrent taps from two
-- devices serialize. Day = Asia/Kolkata. A completed day is never re-opened here (the
-- protected HR "Re-open" path stays separate). attendance_logs stays the clock source of
-- truth; hr_attendance (status, late detection, HR-protected statuses) is still synced by the
-- portal right after, exactly as before — payroll/report logic is unchanged.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.clock_requests (
  request_id uuid primary key,
  email      text not null,
  kind       text not null,
  result     jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.clock_requests enable row level security;   -- written only by be_clock()
create index if not exists idx_clock_requests_created on public.clock_requests (created_at);

create or replace function public.be_clock(p_email text, p_kind text, p_request_id uuid, p_name text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_day   date := (now() at time zone 'Asia/Kolkata')::date;
  v_row   attendance_logs%rowtype;
  v_prev  jsonb;
  v_res   text;
  v_out   json;
begin
  if v_email is null or v_email = '' or p_kind not in ('in','out','status') then
    raise exception 'bad clock request';
  end if;

  -- Idempotency: the same tap (request id) never acts twice.
  if p_request_id is not null then
    select result into v_prev from clock_requests where request_id = p_request_id;
    if found then return v_prev::json; end if;
  end if;

  -- Serialize every action for this employee+day (two devices / rapid taps).
  perform pg_advisory_xact_lock(hashtext(v_email || '|' || v_day::text));
  select * into v_row from attendance_logs
   where lower(employee_email) = v_email and log_date = v_day
   order by log_in_time asc limit 1 for update;

  if p_kind = 'status' then
    v_res := 'status';
  elsif p_kind = 'in' then
    if found and v_row.log_out_time is not null then v_res := 'completed';
    elsif found then v_res := 'already_in';
    else
      insert into attendance_logs (employee_email, employee_name, log_date, log_in_time, log_out_time)
      values (v_email, coalesce(p_name, v_email), v_day, now(), null)
      returning * into v_row;
      v_res := 'ok';
    end if;
  else -- out
    if not found then v_res := 'no_session';
    elsif v_row.log_out_time is not null then v_res := 'completed';
    else
      update attendance_logs set log_out_time = now() where id = v_row.id returning * into v_row;
      v_res := 'ok';
    end if;
  end if;

  v_out := json_build_object(
    'result', v_res,
    'state', case when v_row.id is null then 'none' when v_row.log_out_time is null then 'in' else 'done' end,
    'log_date', v_day,
    'log_in_time', v_row.log_in_time,
    'log_out_time', v_row.log_out_time,
    'id', v_row.id);

  if p_request_id is not null and p_kind <> 'status' then
    insert into clock_requests (request_id, email, kind, result) values (p_request_id, v_email, p_kind, v_out::jsonb)
    on conflict (request_id) do nothing;
    delete from clock_requests where created_at < now() - interval '7 days';
  end if;
  return v_out;
end; $$;
revoke all on function public.be_clock(text, text, uuid, text) from public;
grant execute on function public.be_clock(text, text, uuid, text) to anon, authenticated;
