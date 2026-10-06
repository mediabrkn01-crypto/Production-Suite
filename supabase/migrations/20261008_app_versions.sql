-- ════════════════════════════════════════════════════════════════════════════
-- Live "System update available": one central production-version record.
--
-- The GitHub Action .github/workflows/publish-version.yml runs after every push to main,
-- WAITS until https://work.brokenenglish.in/version.json actually serves the new version
-- (i.e. GitHub Pages finished deploying), and only then calls publish_app_version().
-- A failed or still-running deploy never reaches this table, so nobody is notified early.
-- Every open portal (be-update.js) listens to this row through Supabase Realtime.
--
-- Browsers can only READ app_versions. Writing goes through publish_app_version(), which
-- requires the deploy token stored as the GitHub secret APP_VERSION_TOKEN (only its SHA-256
-- is stored here, in a table no browser can read).
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists pgcrypto;

create table if not exists public.app_versions (
  app_name    text primary key,
  version     text not null,
  build_id    text,
  deployed_at timestamptz not null default now(),
  status      text not null default 'active' check (status in ('active','rolled_back'))
);
alter table public.app_versions enable row level security;
do $$ begin
  create policy "read app version" on public.app_versions for select using (true);
exception when duplicate_object then null; end $$;

create table if not exists public.app_version_secrets (
  app_name   text primary key,
  token_hash text not null
);
alter table public.app_version_secrets enable row level security;   -- no policies: unreadable from browsers
insert into public.app_version_secrets (app_name, token_hash)
values ('broken_english', 'a0d4414543015d0422be3f505d00a2732f5f6ce9f756cb1911b2d52a4e10e1bf')
on conflict (app_name) do update set token_hash = excluded.token_hash;

create or replace function public.publish_app_version(p_app text, p_version text, p_build text, p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from app_version_secrets s
                 where s.app_name = p_app and s.token_hash = encode(digest(p_token, 'sha256'), 'hex')) then
    raise exception 'not authorized';
  end if;
  insert into app_versions (app_name, version, build_id, deployed_at, status)
  values (p_app, p_version, p_build, now(), 'active')
  on conflict (app_name) do update
    set version = excluded.version, build_id = excluded.build_id, deployed_at = now(), status = 'active';
end; $$;
revoke all on function public.publish_app_version(text, text, text, text) from public;
grant execute on function public.publish_app_version(text, text, text, text) to anon, authenticated;

-- Current production version (already deployed) as the starting point.
insert into public.app_versions (app_name, version, build_id)
values ('broken_english', '2026.10.05.1909-u79f', 'cdae844')
on conflict (app_name) do nothing;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_versions') then
    alter publication supabase_realtime add table public.app_versions;
  end if;
end $$;
