-- ════════════════════════════════════════════════════════════════════════════
-- Postpone Class — move ONE class occurrence to a new time (same or another day).
--
-- No second class is created. The recurring batch schedule (batches.day_pattern /
-- time_slot) is never touched:
--   kind = 'class'  a regular / 1:1 (capacity 1) batch occurrence. The shared occurrence
--                   generator (academics.html generateBatchOccurrences) reads the ACTIVE row
--                   for (batch_id, original_date) and emits that one occurrence at
--                   new_date / new_start instead. Every dated view built on it (Today's
--                   Classes, Upcoming, Class & Attendance, dashboard, batch details) follows.
--   kind = 'oto'    a 1:1 session of a group course. The existing oto_sessions row itself is
--                   updated (session_date / start_time / end_time); this table is its history.
--
-- Re-postponing the same class marks the previous row 'superseded' and adds a new one that
-- keeps the true original_date/original_start, so the history chain stays readable.
-- Attendance stays keyed by (batch_name, session_date) as before.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.class_postponements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('class', 'oto')),
  batch_id uuid not null references public.batches(id) on delete cascade,
  oto_session_id uuid references public.oto_sessions(id) on delete cascade,
  trainer_id uuid references public.trainers(id) on delete set null,
  original_date date not null,
  original_start time not null,
  original_end time,
  from_date date not null,            -- where it was just before THIS move (= original on the first move)
  from_start time not null,
  new_date date not null,
  new_start time not null,
  new_end time,
  reason text,
  postponed_by text,
  postponed_by_email text,
  postponed_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'superseded', 'cancelled'))
);

-- One live move per class occurrence — the generator can never see two.
create unique index if not exists uq_class_postponement_active
  on public.class_postponements (batch_id, original_date)
  where kind = 'class' and status = 'active';
create index if not exists idx_class_postponements_batch on public.class_postponements (batch_id);
create index if not exists idx_class_postponements_new_date on public.class_postponements (new_date);
create index if not exists idx_class_postponements_oto on public.class_postponements (oto_session_id);

comment on table public.class_postponements is
  'Per-occurrence class postponements (history). kind=class overrides one generated batch occurrence; kind=oto logs a move of an oto_sessions row.';

-- Same access model as oto_sessions (Academic portal users read/write class data).
alter table public.class_postponements enable row level security;
do $$ begin
  create policy "class_postponements_all" on public.class_postponements for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Live updates (other open Academic tabs refresh their schedule views).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'class_postponements') then
    execute 'alter publication supabase_realtime add table public.class_postponements';
  end if;
end $$;

-- Check
select count(*) as class_postponements_rows from public.class_postponements;
