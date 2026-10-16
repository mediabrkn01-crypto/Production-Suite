-- ════════════════════════════════════════════════════════════════════════════
-- 1) DEPARTMENT-SPECIFIC HOLIDAYS
--    Department = the employee's division (hr_employees.division: education, production,
--    sales, hr, accounts, management, other …) — the same stable key hr_official_events
--    .applies_to already uses. hr_divisions is now the master list of those keys (HR's
--    Department pickers read it), and a holiday's scope is relational:
--
--      hr_holidays.holiday_scope   'all' (every department — exactly today's behaviour)
--                                  'departments' (only the rows in hr_holiday_departments)
--      hr_holiday_departments      (holiday_id → hr_holidays, division_code → hr_divisions)
--      hr_holidays.departments     read cache of the join rows, kept in sync by a trigger, so
--                                  every portal keeps a plain select('*') (no embed needed).
--
--    Existing holidays become scope 'all' → nothing changes for them.
--
-- 2) COMPANY ASSETS
--      hr_asset_types         HR-managed list of types (custom types allowed)
--      hr_assets              one row per physical item, with its CURRENT status/holder
--      hr_asset_assignments   one row per hand-over; closed (returned_date) on return or
--                             transfer, never overwritten — full holder history
--      hr_asset_events        timeline: created / assigned / returned / transferred /
--                             repair / retired / edited (+ who and when)
--    At most ONE open assignment per asset (partial unique index).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Departments master ───────────────────────────────────────────────────────
create table if not exists public.hr_divisions (
  code        text primary key,
  name        text not null,
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
insert into public.hr_divisions (code, name, sort_order) values
  ('education',  'Academics',            1),
  ('sales',      'Sales',                2),
  ('production', 'Media / Production',   3),
  ('hr',         'HR',                   4),
  ('accounts',   'Accounts',             5),
  ('management', 'Management',           6),
  ('other',      'Administration / Other', 7)
on conflict (code) do nothing;
-- Any division already used on an employee but missing from the list (never lose one).
insert into public.hr_divisions (code, name, sort_order)
select distinct e.division, initcap(e.division), 50
from public.hr_employees e
where coalesce(e.division, '') <> ''
on conflict (code) do nothing;

alter table public.hr_divisions enable row level security;
drop policy if exists hr_divisions_all on public.hr_divisions;
create policy hr_divisions_all on public.hr_divisions for all using (true) with check (true);

-- ── Holiday scope ────────────────────────────────────────────────────────────
alter table public.hr_holidays add column if not exists holiday_scope text not null default 'all';
alter table public.hr_holidays add column if not exists departments   text[] not null default '{}';
alter table public.hr_holidays add column if not exists updated_at    timestamptz;
alter table public.hr_holidays add column if not exists updated_by    text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'hr_holidays_scope_chk') then
    alter table public.hr_holidays add constraint hr_holidays_scope_chk check (holiday_scope in ('all', 'departments'));
  end if;
end $$;

create table if not exists public.hr_holiday_departments (
  holiday_id     uuid not null references public.hr_holidays(id) on delete cascade,
  division_code  text not null references public.hr_divisions(code) on update cascade,
  primary key (holiday_id, division_code)
);
alter table public.hr_holiday_departments enable row level security;
drop policy if exists hr_holiday_departments_all on public.hr_holiday_departments;
create policy hr_holiday_departments_all on public.hr_holiday_departments for all using (true) with check (true);

create or replace function public.hr_holiday_departments_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.holiday_id, old.holiday_id);
begin
  update public.hr_holidays h
     set departments = coalesce((select array_agg(d.division_code order by d.division_code)
                                   from public.hr_holiday_departments d where d.holiday_id = v_id), '{}')
   where h.id = v_id;
  return null;
end $$;
drop trigger if exists trg_hr_holiday_departments_sync on public.hr_holiday_departments;
create trigger trg_hr_holiday_departments_sync
  after insert or update or delete on public.hr_holiday_departments
  for each row execute function public.hr_holiday_departments_sync();

-- ── Company assets ───────────────────────────────────────────────────────────
create table if not exists public.hr_asset_types (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  active      boolean not null default true,
  sort_order  int not null default 100,
  created_at  timestamptz not null default now()
);
insert into public.hr_asset_types (name, sort_order) values
  ('Laptop', 1), ('Desktop / System', 2), ('Mobile Phone', 3), ('Tablet', 4), ('Monitor', 5),
  ('Camera', 6), ('Hard Disk / SSD', 7), ('Keyboard', 8), ('Mouse', 9), ('Headphones', 10), ('Other equipment', 99)
on conflict (name) do nothing;

create table if not exists public.hr_assets (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  type_id                uuid references public.hr_asset_types(id),
  asset_code             text,
  brand                  text,
  model                  text,
  serial_number          text,
  condition              text,
  purchase_date          date,
  status                 text not null default 'available'
                         check (status in ('available', 'assigned', 'returned', 'repair', 'retired')),
  current_employee_id    uuid references public.hr_employees(id),
  current_assignment_id  uuid,
  document_url           text,
  notes                  text,
  created_at             timestamptz not null default now(),
  created_by             text,
  updated_at             timestamptz
);
create unique index if not exists uq_hr_assets_code on public.hr_assets (lower(asset_code)) where coalesce(asset_code, '') <> '';
create index if not exists idx_hr_assets_holder on public.hr_assets (current_employee_id);

create table if not exists public.hr_asset_assignments (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references public.hr_assets(id) on delete cascade,
  employee_id       uuid not null references public.hr_employees(id),
  assigned_date     date not null default current_date,
  assigned_by       text,
  condition_out     text,
  notes             text,
  returned_date     date,
  return_condition  text,
  return_notes      text,
  returned_by       text,
  end_reason        text check (end_reason in ('returned', 'transferred')),
  created_at        timestamptz not null default now()
);
create unique index if not exists uq_hr_asset_open_assignment on public.hr_asset_assignments (asset_id) where returned_date is null;
create index if not exists idx_hr_asset_assign_emp on public.hr_asset_assignments (employee_id, returned_date);

create table if not exists public.hr_asset_events (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references public.hr_assets(id) on delete cascade,
  event             text not null,   -- created | assigned | returned | transferred | repair | retired | edited | status
  employee_id       uuid references public.hr_employees(id),
  from_employee_id  uuid references public.hr_employees(id),
  details           jsonb not null default '{}',
  actor_email       text,
  actor_name        text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_hr_asset_events on public.hr_asset_events (asset_id, created_at);

do $$ declare t text; begin
  foreach t in array array['hr_asset_types', 'hr_assets', 'hr_asset_assignments', 'hr_asset_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format('create policy %I on public.%I for all using (true) with check (true)', t || '_all', t);
  end loop;
end $$;

-- Realtime for the new tables (portals refresh live through be-live.js).
do $$ declare t text; begin
  foreach t in array array['hr_divisions', 'hr_holiday_departments', 'hr_assets', 'hr_asset_assignments', 'hr_asset_events', 'hr_asset_types'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
