-- ════════════════════════════════════════════════════════════════════════════
-- HEADER THEMES v2 — more presets, theme type, portal targeting. Run after 20261101.
--
--   preset        + vishu | onam | newyear
--   kind          seasonal | festival | special (special day) | custom (custom event)
--   portals       which ERP suites show it: media | academics | sales | hr | manager;
--                 empty = every portal (departments still narrow it per person)
--
-- New built-ins: New Year (Dec 31 – Jan 1, yearly), Vishu (Apr 14 – 15, yearly) and Onam
-- (no dates — the festival moves every year; HR sets them, like Navaratri).
-- Realistic banner art for Christmas, Independence Day, Vishu, Onam, New Year and Monsoon
-- ships with the app (assets/header-themes/*.webp) and is used unless HR uploads another.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.erp_header_themes drop constraint if exists erp_header_themes_preset_check;
alter table public.erp_header_themes add constraint erp_header_themes_preset_check
  check (preset in ('christmas', 'monsoon', 'summer', 'navaratri', 'independence', 'vishu', 'onam', 'newyear', 'custom'));

alter table public.erp_header_themes add column if not exists kind text not null default 'festival';
alter table public.erp_header_themes drop constraint if exists erp_header_themes_kind_check;
alter table public.erp_header_themes add constraint erp_header_themes_kind_check check (kind in ('seasonal', 'festival', 'special', 'custom'));
alter table public.erp_header_themes add column if not exists portals text[] not null default '{}';

update public.erp_header_themes set kind = 'seasonal' where preset in ('monsoon', 'summer') and kind = 'festival';
update public.erp_header_themes set kind = 'special'  where preset = 'independence' and kind = 'festival';

insert into public.erp_header_themes (preset, kind, name, start_date, end_date, repeat_yearly, auto_active, priority)
select v.preset, v.kind, v.name, v.s::date, v.e::date, true, v.auto, v.pri
from (values
  ('newyear', 'special',  'New Year', '2026-12-31', '2027-01-01', true,  95),
  ('vishu',   'festival', 'Vishu',    '2026-04-14', '2026-04-15', true,  90),
  ('onam',    'festival', 'Onam',     null,         null,         false, 90)
) as v(preset, kind, name, s, e, auto, pri)
where not exists (select 1 from public.erp_header_themes t where t.preset = v.preset);
