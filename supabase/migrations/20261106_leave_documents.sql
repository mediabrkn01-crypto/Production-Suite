-- ════════════════════════════════════════════════════════════════════════════
-- LEAVE SUPPORTING DOCUMENTS — medical certificates / proof uploaded with a leave request.
--
--   storage bucket  leave-docs    PRIVATE (no public URL). Objects at <employee id>/<month>/<uuid>-<name>.
--                                 Uploads use a one-time signed upload URL and views a 2-minute
--                                 signed URL, both issued by the `leave-docs` edge function only to
--                                 the employee themself, HR and leadership.
--   hr_leave_requests.proof_files [{path,name,size,type}] — the attached documents (proof_url stays
--                                 for older link-only requests).
--
-- The project's catch-all storage policies ("allow anon uploads awqvv4_*", condition TRUE for every
-- bucket) are narrowed to exclude leave-docs — every other bucket behaves exactly as before.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('leave-docs', 'leave-docs', false, 20971520, array[
  'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_0') then
    alter policy "allow anon uploads awqvv4_0" on storage.objects using (bucket_id <> 'leave-docs');
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_1') then
    alter policy "allow anon uploads awqvv4_1" on storage.objects with check (bucket_id <> 'leave-docs');
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_2') then
    alter policy "allow anon uploads awqvv4_2" on storage.objects using (bucket_id <> 'leave-docs');
  end if;
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'allow anon uploads awqvv4_3') then
    alter policy "allow anon uploads awqvv4_3" on storage.objects using (bucket_id <> 'leave-docs');
  end if;
end $$;

alter table public.hr_leave_requests add column if not exists proof_files jsonb not null default '[]'::jsonb;
