-- ════════════════════════════════════════════════════════════════════════════
-- CONTENT CALENDAR — one calendar for every department (Media publishing schedule,
-- Academic workshops, Sales campaigns, HR events, Management milestones, company-wide events).
--
--   content_calendar_types        extendable list of item types (+ which departments see them first)
--   content_calendar_items        one row per item; recurring items are ONE row + a rule
--                                 (never pre-generated copies → no duplicates)
--   content_calendar_assignees    item ↔ employees (optional, many)
--   content_calendar_occurrences  per-date status of a RECURRING item (Completed on Monday's
--                                 occurrence doesn't complete next Monday). One-off items keep
--                                 their status on the item row.
--
-- Reminders: items.reminders = {'morning','start','10','30','60','m:<minutes>'}.
-- content_calendar_dispatch() turns DUE reminders into Notification Center rows
-- (erp_notifications), computed from database time in the company timezone (erp_tz()).
-- Delivery is tracked by erp_notifications' unique (recipient_email, dedupe_key):
--   dedupe_key = 'cal:<item>:<date>:<reminder>'  → each reminder is delivered exactly once,
-- however many browsers / cron runs call the dispatcher. Completed / cancelled occurrences
-- get no reminders. It runs from pg_cron when available (every 5 min) and from every open
-- ERP page (every 2 min) — the browser only triggers it, the decision is the server's.
--
-- Writes go through the `calendar` edge function (permission-checked); the browser key can
-- only READ these tables. Calendar events are NOT holidays (hr_holidays stays separate).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- Company timezone in ONE place (used by reminders; the apps use the same zone).
create or replace function public.erp_tz() returns text language sql immutable as $$ select 'Asia/Kolkata'::text $$;

create table if not exists public.content_calendar_types (
  code         text primary key,
  label        text not null,
  departments  text[] not null default '{}',    -- empty = every department
  sort_order   int not null default 100,
  active       boolean not null default true
);
insert into public.content_calendar_types (code, label, departments, sort_order) values
  ('content_post', 'Content Post',    '{production}', 1),
  ('reel',         'Reel',            '{production}', 2),
  ('video',        'Video',           '{production}', 3),
  ('youtube',      'YouTube',         '{production}', 4),
  ('poster',       'Poster',          '{production}', 5),
  ('thumbnail',    'Thumbnail',       '{production}', 6),
  ('campaign',     'Campaign',        '{production,sales,hr}', 7),
  ('workshop',     'Workshop',        '{education}', 8),
  ('live_class',   'Live Class',      '{education}', 9),
  ('course_launch','Course Launch',   '{education,sales}', 10),
  ('student_activity','Student Activity','{education}', 11),
  ('offer',        'Offer Launch',    '{sales}', 12),
  ('follow_up',    'Follow-up',       '{sales}', 13),
  ('event',        'Event',           '{}', 20),
  ('meeting',      'Meeting',         '{}', 21),
  ('deadline',     'Deadline',        '{}', 22),
  ('announcement', 'Announcement',    '{}', 23),
  ('launch',       'Launch',          '{}', 24),
  ('other',        'Other',           '{}', 99)
on conflict (code) do nothing;

create table if not exists public.content_calendar_items (
  id                      uuid primary key default gen_random_uuid(),
  title                   text not null check (length(trim(title)) > 0),
  description             text,
  department              text not null,                 -- hr_divisions.code or 'company'
  item_type               text not null default 'other', -- content_calendar_types.code (free text allowed)
  platform                text,                          -- Instagram / YouTube / Facebook / Website …
  item_date               date not null,
  start_time              time,                          -- null = all day
  priority                text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status                  text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  reminders               text[] not null default '{}',
  recurrence              text check (recurrence in ('daily', 'weekly', 'weekdays', 'monthly')),
  recurrence_days         int[] not null default '{}',   -- 0=Sun … 6=Sat (weekdays rule)
  recurrence_until        date,
  reference_url           text,
  attachment_url          text,
  related_assignment_id   bigint references public.assignments(id) on delete set null,
  created_by_employee_id  uuid references public.hr_employees(id),
  created_by_name         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_by            text,
  completed_at            timestamptz
);
create index if not exists idx_cal_items_date on public.content_calendar_items (item_date);
create index if not exists idx_cal_items_dept_date on public.content_calendar_items (department, item_date);
create index if not exists idx_cal_items_recurring on public.content_calendar_items (recurrence) where recurrence is not null;

create table if not exists public.content_calendar_assignees (
  item_id      uuid not null references public.content_calendar_items(id) on delete cascade,
  employee_id  uuid not null references public.hr_employees(id),
  created_at   timestamptz not null default now(),
  primary key (item_id, employee_id)
);
create index if not exists idx_cal_assignees_emp on public.content_calendar_assignees (employee_id);

create table if not exists public.content_calendar_occurrences (
  item_id       uuid not null references public.content_calendar_items(id) on delete cascade,
  occ_date      date not null,
  status        text not null check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  completed_by  text,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (item_id, occ_date)
);

do $$ declare t text; begin
  foreach t in array array['content_calendar_types', 'content_calendar_items', 'content_calendar_assignees', 'content_calendar_occurrences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (true)', t || '_read', t);   -- writes: edge fn only
    if t <> 'content_calendar_types' and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Does a (possibly recurring) item happen on day d?
create or replace function public.content_calendar_occurs(i public.content_calendar_items, d date) returns boolean
language sql immutable as $$
  select case
    when d < i.item_date then false
    when i.recurrence is null then d = i.item_date
    when i.recurrence_until is not null and d > i.recurrence_until then false
    when i.recurrence = 'daily' then true
    when i.recurrence = 'weekly' then extract(dow from d) = extract(dow from i.item_date)
    when i.recurrence = 'weekdays' then extract(dow from d)::int = any (case when cardinality(i.recurrence_days) > 0 then i.recurrence_days else array[extract(dow from i.item_date)::int] end)
    when i.recurrence = 'monthly' then extract(day from d) = least(extract(day from i.item_date), extract(day from (date_trunc('month', d) + interval '1 month - 1 day')))
    else false end
$$;

-- ── Reminder dispatcher (idempotent; safe to call as often as you like) ──────────────────
create or replace function public.content_calendar_dispatch() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_now   timestamptz := now();
  v_today date := (now() at time zone erp_tz())::date;
  v_n     int := 0;
  i       public.content_calendar_items; d date; r text; v_at timestamptz; v_start timestamptz; v_status text;
  v_title text; v_msg text; v_when text; v_mins int; rec record;
begin
  for i in
    select * from content_calendar_items c
    where c.status not in ('completed', 'cancelled') and cardinality(c.reminders) > 0
      and c.item_date <= v_today + 1
      and (c.recurrence is not null or c.item_date >= v_today - 1)
      and (c.recurrence_until is null or c.recurrence_until >= v_today - 1)
  loop
    foreach d in array array[v_today - 1, v_today, v_today + 1] loop
      continue when not content_calendar_occurs(i, d);
      if i.recurrence is not null then
        select o.status into v_status from content_calendar_occurrences o where o.item_id = i.id and o.occ_date = d;
        continue when v_status in ('completed', 'cancelled');
      end if;
      v_start := case when i.start_time is null then (d + time '09:00') at time zone erp_tz() else (d + i.start_time) at time zone erp_tz() end;
      v_when  := to_char(d, 'DD Mon') || coalesce(' · ' || to_char(i.start_time, 'HH12:MI AM'), '');
      foreach r in array i.reminders loop
        v_mins := case when r ~ '^m:\d+$' then substr(r, 3)::int when r ~ '^\d+$' then r::int when r = 'start' then 0 else null end;
        if r = 'morning' then
          v_at := (d + time '08:00') at time zone erp_tz();
          v_title := 'Today: ' || i.title;
          v_msg := 'Scheduled ' || case when i.start_time is null then 'today' else 'today at ' || to_char(i.start_time, 'HH12:MI AM') end || '.';
        elsif v_mins is not null then
          continue when i.start_time is null and v_mins > 0;   -- offsets need a time
          v_at := v_start - make_interval(mins => v_mins);
          v_title := case when v_mins = 0 then 'Starting now: ' || i.title
                          when v_mins < 60 then 'Due in ' || v_mins || ' minutes'
                          when v_mins % 60 = 0 then 'Due in ' || (v_mins / 60) || ' hour' || case when v_mins = 60 then '' else 's' end
                          else 'Due in ' || v_mins || ' minutes' end;
          v_msg := i.title || ' — ' || v_when || '.';
        else
          continue;
        end if;
        -- Due now, and not stale (a reminder is never sent after the item already started
        -- + 2 h grace, or more than 12 h late).
        continue when v_at > v_now or v_now > greatest(v_start, v_at) + interval '2 hours' or v_now - v_at > interval '12 hours';
        for rec in
          select distinct lower(e.portal_email) as email, e.id
          from hr_employees e
          where coalesce(e.portal_email, '') <> '' and coalesce(lower(e.employment_status), 'active') not in ('exited', 'inactive')
            and (e.id in (select a.employee_id from content_calendar_assignees a where a.item_id = i.id)
                 or (not exists (select 1 from content_calendar_assignees a where a.item_id = i.id) and e.id = i.created_by_employee_id))
        loop
          insert into erp_notifications (recipient_email, recipient_employee_id, type, title, message, entity_type, entity_id, dedupe_key, link, metadata)
          values (rec.email, rec.id, 'calendar_reminder', v_title, v_msg, 'content_calendar_item', i.id::text,
                  'cal:' || i.id || ':' || d || ':' || r, 'cal:' || i.id || ':' || d,
                  jsonb_build_object('title', i.title, 'date', d, 'time', i.start_time, 'department', i.department, 'reminder', r))
          on conflict (recipient_email, dedupe_key) do nothing;
          if found then v_n := v_n + 1; end if;
        end loop;
      end loop;
    end loop;
  end loop;
  return v_n;
end $$;
grant execute on function public.content_calendar_dispatch() to anon, authenticated;

-- Every 5 minutes from the database itself when pg_cron is installed (no-op otherwise).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'content-calendar-reminders';
    perform cron.schedule('content-calendar-reminders', '*/5 * * * *', 'select public.content_calendar_dispatch()');
  end if;
exception when others then raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;
