-- ════════════════════════════════════════════════════════════════════════════
-- PERSONAL SETTINGS + BACKGROUND IMAGES — Settings → Appearance → Background Customization.
--
-- Why a DB / storage change: the ERP had no per-user settings stored on the server (the theme
-- is a per-device localStorage choice), and a background must follow the employee to another
-- device and survive logout. One generic table holds each employee's personal UI settings so
-- later preferences reuse it instead of growing new tables.
--
--   public.erp_user_settings   one row per employee: settings jsonb ({ background: { dark, light } }).
--                              RLS on with NO policies → the browser key can't read or write it.
--                              Only the `user-settings` edge function (service role) touches it,
--                              always keyed by the employee resolved from the caller's ERP session.
--   storage bucket erp-backgrounds  PRIVATE, 8 MB, JPEG / PNG / WebP only (enforced by Storage).
--                              Objects at <employee id>/<uuid>.<ext>; uploads via one-time signed
--                              upload URLs and reads via signed URLs, both issued only to the owner.
--
-- The project's catch-all storage policies ("allow anon uploads awqvv4_*", which already exclude
-- leave-docs) are narrowed to exclude erp-backgrounds too — every other bucket behaves as before.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.erp_user_settings (
  employee_id uuid primary key references public.hr_employees(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.erp_user_settings enable row level security;
revoke all on public.erp_user_settings from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('erp-backgrounds', 'erp-backgrounds', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_0') then
    alter policy "allow anon uploads awqvv4_0" on storage.objects using (bucket_id not in ('leave-docs', 'erp-backgrounds'));
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_1') then
    alter policy "allow anon uploads awqvv4_1" on storage.objects with check (bucket_id not in ('leave-docs', 'erp-backgrounds'));
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_2') then
    alter policy "allow anon uploads awqvv4_2" on storage.objects using (bucket_id not in ('leave-docs', 'erp-backgrounds'));
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_3') then
    alter policy "allow anon uploads awqvv4_3" on storage.objects using (bucket_id not in ('leave-docs', 'erp-backgrounds'));
  end if;
end $$;
