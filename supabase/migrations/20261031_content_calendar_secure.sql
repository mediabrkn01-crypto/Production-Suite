-- ════════════════════════════════════════════════════════════════════════════
-- CONTENT CALENDAR — department visibility enforced on the server.
--
-- Until now the browser key could read every calendar row and the page hid what you
-- shouldn't see. From here the calendar data is readable ONLY through the `calendar` edge
-- function (actions list / item), which returns:
--   manager tier / HR admin  → every department
--   everyone else            → own department + departments they manage + company-wide
--                              + the individual items assigned to them
--
--   content_calendar_items / _assignees / _occurrences   browser SELECT policy removed
--   content_calendar_types                               stays readable (labels only)
--   content_calendar_pings                               one row that changes whenever the
--                                                        calendar changes (no titles, no
--                                                        departments) → open pages refresh
--                                                        live and re-fetch through the function
-- The reminder dispatcher is SECURITY DEFINER and keeps working. Run after 20261030.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

do $$ declare t text; begin
  foreach t in array array['content_calendar_items', 'content_calendar_assignees', 'content_calendar_occurrences'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    -- RLS stays enabled with no policy → no browser access; the service role bypasses RLS.
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

create table if not exists public.content_calendar_pings (
  id          int primary key default 1 check (id = 1),
  changed_at  timestamptz not null default now()
);
insert into public.content_calendar_pings (id) values (1) on conflict (id) do nothing;
alter table public.content_calendar_pings enable row level security;
drop policy if exists content_calendar_pings_read on public.content_calendar_pings;
create policy content_calendar_pings_read on public.content_calendar_pings for select using (true);
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'content_calendar_pings') then
    execute 'alter publication supabase_realtime add table public.content_calendar_pings';
  end if;
end $$;

create or replace function public.content_calendar_ping() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update content_calendar_pings set changed_at = now() where id = 1;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['content_calendar_items', 'content_calendar_assignees', 'content_calendar_occurrences'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_ping', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each statement execute function public.content_calendar_ping()', 'trg_' || t || '_ping', t);
  end loop;
end $$;
