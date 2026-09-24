-- Applied 2026-09-24. Resolves Xale counselor names to hr_employees.id for every Sales
-- counselor, at the DB level, so ownership never depends on the webhook version deployed.

create table if not exists public.crm_counsellor_aliases (
  id uuid primary key default gen_random_uuid(),
  crm_name text not null,
  employee_id uuid not null references public.hr_employees(id) on delete cascade,
  created_at timestamptz default now()
);
create unique index if not exists uq_crm_counsellor_alias_norm
  on public.crm_counsellor_aliases (lower(regexp_replace(crm_name, '[^a-zA-Z0-9]', '', 'g')));

-- Alias first, then a UNIQUE normalized-name match among Sales employees (ambiguous → null).
create or replace function public.fn_resolve_crm_counsellor(p_name text)
returns uuid language plpgsql stable as $$
declare
  v_norm text := lower(regexp_replace(coalesce(p_name,''), '[^a-zA-Z0-9]', '', 'g'));
  v_id uuid;
  v_count int;
begin
  if v_norm = '' then return null; end if;
  select employee_id into v_id from public.crm_counsellor_aliases
   where lower(regexp_replace(crm_name, '[^a-zA-Z0-9]', '', 'g')) = v_norm limit 1;
  if v_id is not null then return v_id; end if;
  select count(*), min(id::text)::uuid into v_count, v_id from public.hr_employees
   where division = 'sales'
     and lower(regexp_replace(coalesce(full_name,''), '[^a-zA-Z0-9]', '', 'g')) = v_norm;
  if v_count = 1 then return v_id; end if;
  return null;
end $$;

create or replace function public.fn_students_resolve_crm_counsellor()
returns trigger language plpgsql as $$
begin
  if coalesce(new.crm_source,'') <> 'xale' then return new; end if;
  if tg_op = 'INSERT' then
    if new.counsellor_id is null then
      new.counsellor_id := public.fn_resolve_crm_counsellor(new.source_counsellor);
    end if;
  elsif new.source_counsellor is distinct from old.source_counsellor then
    new.counsellor_id := public.fn_resolve_crm_counsellor(new.source_counsellor);
  elsif new.counsellor_id is null then
    new.counsellor_id := public.fn_resolve_crm_counsellor(new.source_counsellor);
  end if;
  return new;
end $$;

drop trigger if exists trg_students_resolve_crm_counsellor on public.students;
create trigger trg_students_resolve_crm_counsellor
  before insert or update on public.students
  for each row execute function public.fn_students_resolve_crm_counsellor();

-- One-time relink of Xale students whose owner was never resolved.
update public.students set counsellor_id = public.fn_resolve_crm_counsellor(source_counsellor)
where crm_source = 'xale' and counsellor_id is null
  and public.fn_resolve_crm_counsellor(source_counsellor) is not null;
