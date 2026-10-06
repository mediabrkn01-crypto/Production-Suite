-- ════════════════════════════════════════════════════════════════════════════
-- Designations master + one clean title per employee (no Senior / Mid-Level / Junior tiers)
--
-- Employee structure after this:
--   division        = Department            (education / sales / production / hr / …)
--   designation     = ONE clean job title   (Fluency Coach, Class Coordinator, Video Editor …)
--   employment_type = full_time / part_time (separate badge)
--   system_role     = Access Role override  (empty → the designation's default access below)
--
-- Only titles are normalised. Employee IDs, attendance, leave, payroll, payslips, documents,
-- logins and departments are untouched. Every changed row keeps its previous values in
-- hr_employees.designation_legacy ("old designation || old team roles"). Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Designations master (HR → Designations) ------------------------------------------------
create table if not exists public.hr_designations (
  id          uuid primary key default gen_random_uuid(),
  division    text not null,
  name        text not null,
  access_role text,                 -- default access: academic_head | trainer | … | null = standard
  active      boolean not null default true,
  sort_order  integer not null default 50,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_hr_designations_name on public.hr_designations (lower(name));
alter table public.hr_designations enable row level security;
drop policy if exists hr_designations_all on public.hr_designations;
create policy hr_designations_all on public.hr_designations for all using (true) with check (true);

insert into public.hr_designations (division, name, access_role, sort_order) values
  ('education',  'Academic Head',                'academic_head', 1),
  ('education',  'Class Coordinator',            'academic_head', 2),
  ('education',  'Operations Manager',           'academic_head', 3),
  ('education',  'Fluency Coach',                'trainer',       4),
  ('sales',      'Student Counselor',            null, 1),
  ('sales',      'Student Counselor Head',       null, 2),
  ('sales',      'Sales Executive',              null, 3),
  ('production', 'Video Editor',                 null, 1),
  ('production', 'Editor',                       null, 2),
  ('production', 'Graphic Designer',             null, 3),
  ('production', 'Designer',                     null, 4),
  ('production', 'Cinematographer',              null, 5),
  ('production', 'Photographer',                 null, 6),
  ('production', 'Colorist',                     null, 7),
  ('production', 'VFX & Motion Graphics Artist', null, 8),
  ('production', 'Production Coordinator',       null, 9),
  ('hr',         'HR Manager',                   null, 1),
  ('hr',         'HR Executive',                 null, 2),
  ('hr',         'HR Intern',                    null, 3),
  ('accounts',   'Accounts Manager',             null, 1),
  ('accounts',   'Accounts Executive',           null, 2),
  ('accounts',   'Accounts Intern',              null, 3),
  ('other',      'Administrator',                null, 1)
on conflict (lower(name)) do nothing;

-- 2. Keep the old values before touching anything ------------------------------------------
alter table public.hr_employees add column if not exists designation_legacy text;
update public.hr_employees
   set designation_legacy = coalesce(designation, '') || ' || ' || coalesce(department, '')
 where designation_legacy is null;

-- 3. Remove seniority tiers from team roles and titles --------------------------------------
update public.hr_employees
   set department = regexp_replace(department, '(^|,\s*)(Senior|Mid-Level|Junior)\s+', '\1', 'g')
 where department ~ '(^|,\s*)(Senior|Mid-Level|Junior)\s+';
update public.hr_employees
   set designation = regexp_replace(designation, '^(Senior|Mid-Level|Junior)\s+', '', 'i')
 where designation ~* '^(Senior|Mid-Level|Junior)\s+';

-- 4. One clean designation per person ------------------------------------------------------
-- Anyone who ALREADY has a designation from the master list (e.g. set by hand in HR) is never
-- touched below — only old / free-text / tiered titles are mapped.
create or replace function pg_temp.is_clean(t text) returns boolean language sql as
  $f$ select exists (select 1 from public.hr_designations d where lower(d.name) = lower(coalesce(t, ''))) $f$;
-- Education
update public.hr_employees set designation = 'Academic Head'
 where not pg_temp.is_clean(designation) and division = 'education' and department ~ '(^|,\s*)Academic Head(\s*,|$)';
update public.hr_employees set designation = 'Class Coordinator'
 where not pg_temp.is_clean(designation) and division = 'education' and department ~ '(^|,\s*)Class Coordinator(\s*,|$)'
   and department !~ '(^|,\s*)Academic Head(\s*,|$)';
update public.hr_employees set designation = 'Fluency Coach'
 where not pg_temp.is_clean(designation) and division = 'education'
   and coalesce(designation, '') !~* '^(Academic Head|Class Coordinator|Operations Manager)$'
   and (coalesce(designation, '') ~* '(trainer|coach)' or coalesce(designation, '') = '' or department ~* 'coach');
-- Sales
update public.hr_employees set designation = 'Student Counselor Head'
 where not pg_temp.is_clean(designation) and division = 'sales' and department ~ '(^|,\s*)Student Counselor Head(\s*,|$)';
update public.hr_employees set designation = 'Student Counselor'
 where not pg_temp.is_clean(designation) and division = 'sales' and coalesce(designation, '') !~* '^(Student Counselor Head|Sales Executive)$'
   and (coalesce(designation, '') ~* 'counsel' or department ~* 'student counselor');
-- Production: generic "Employee" titles take their primary team role
update public.hr_employees set designation = case
         when department ~* '^\s*video editor'    then 'Video Editor'
         when department ~* '^\s*graphic designer' then 'Graphic Designer'
         when department ~* '^\s*editor'           then 'Editor'
         when department ~* '^\s*designer'         then 'Designer'
         when department ~* '^\s*cinematographer'  then 'Cinematographer'
         when department ~* '^\s*photographer'     then 'Photographer'
         when department ~* '^\s*colorist'         then 'Colorist'
         when department ~* '^\s*vfx'              then 'VFX & Motion Graphics Artist'
         when department ~* '^\s*production coordinator' then 'Production Coordinator'
         else designation end
 where not pg_temp.is_clean(designation) and division = 'production' and coalesce(designation, '') ~* '^(employee|)$';
-- HR
update public.hr_employees set designation = 'HR Manager'
 where not pg_temp.is_clean(designation) and division = 'hr' and department ~ '(^|,\s*)HR Manager(\s*,|$)';

-- 5. Review: every employee's old → new title
select full_name, division, designation_legacy as before, designation as designation_now, department as team_roles_now, employment_type, system_role
  from public.hr_employees order by division, full_name;
