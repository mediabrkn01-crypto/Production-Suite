-- ════════════════════════════════════════════════════════════════════════════
-- SEASONAL / SPECIAL-DAY HEADER THEMES — small decorative layers on the shared ERP top
-- header only (be-shell.js .bes-header): snow, rain, sunlight, diyas, tricolor accents.
-- Nothing else on the page changes; with no active theme the header is the default one.
--
--   erp_header_themes   one row per theme
--     preset            visual style: christmas | monsoon | summer | navaratri | independence | custom
--     start_date/end_date + repeat_yearly   date window (Asia/Kolkata); repeat_yearly uses only
--                       month-day, so "Dec 20 – Dec 31" or "Dec 28 – Jan 3" recur every year
--     auto_active       follow the date window
--     manual_state      auto | on (force on now) | off (force off)
--     priority          highest wins when several themes are active
--     departments       hr_divisions codes; empty = every department
--     enabled           master switch
--     config            effect switches: {particles, caps, overlay, glow, accent, intensity}
--     asset_url         optional decorative image (uploaded to celebration-media)
--
-- Read by every portal (be-season.js); edited from HR → Header Themes. Same access model as
-- the other HR settings tables. Navaratri ships without dates (they change every year) —
-- HR sets them. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.erp_header_themes (
  id             uuid primary key default gen_random_uuid(),
  preset         text not null check (preset in ('christmas', 'monsoon', 'summer', 'navaratri', 'independence', 'custom')),
  name           text not null check (length(trim(name)) > 0),
  start_date     date,
  end_date       date,
  repeat_yearly  boolean not null default true,
  auto_active    boolean not null default true,
  manual_state   text not null default 'auto' check (manual_state in ('auto', 'on', 'off')),
  priority       int not null default 50,
  departments    text[] not null default '{}',
  enabled        boolean not null default true,
  config         jsonb not null default '{}',
  asset_url      text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Built-in presets (added once; HR edits them afterwards).
insert into public.erp_header_themes (preset, name, start_date, end_date, repeat_yearly, auto_active, priority)
select v.preset, v.name, v.s::date, v.e::date, true, v.auto, v.pri
from (values
  ('christmas',    'Christmas',        '2026-12-20', '2026-12-31', true,  90),
  ('independence', 'Independence Day', '2026-08-15', '2026-08-15', true,  100),
  ('navaratri',    'Navaratri',        null,         null,         false, 90),
  ('monsoon',      'Monsoon',          '2026-06-01', '2026-09-30', true,  10),
  ('summer',       'Summer',           '2026-03-01', '2026-05-31', true,  10)
) as v(preset, name, s, e, auto, pri)
where not exists (select 1 from public.erp_header_themes t where t.preset = v.preset);

alter table public.erp_header_themes enable row level security;
drop policy if exists erp_header_themes_all on public.erp_header_themes;
create policy erp_header_themes_all on public.erp_header_themes for all using (true) with check (true);
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'erp_header_themes') then
    execute 'alter publication supabase_realtime add table public.erp_header_themes';
  end if;
end $$;
