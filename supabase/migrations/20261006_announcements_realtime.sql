-- ════════════════════════════════════════════════════════════════════════════
-- HR Announcements → real-time announcement + engagement system.
-- Extends the existing hr_announcements / hr_announcement_reads (no duplicate tables).
--
--  hr_announcements            + pin, archive, replies on/off, acknowledgement required,
--                                link / attachment / image URLs (Drive links, like
--                                hr_employee_documents), multi-department + role audiences,
--                                published/edited audit, notify_seq (bumped only when HR
--                                chooses "notify employees about this update").
--  hr_announcement_reads       + employee_id, acknowledged_at; one row per employee.
--  hr_announcement_reactions   one reaction per employee per announcement (upsert).
--  hr_announcement_replies     short replies (≤ 500 chars) when HR allows them.
--  Realtime: all four tables added to the supabase_realtime publication so every portal
--  receives inserts/updates live (no refresh).
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hr_announcements
  add column if not exists pinned boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text,
  add column if not exists allow_replies boolean not null default false,
  add column if not exists require_ack boolean not null default false,
  add column if not exists link_url text,
  add column if not exists attachment_url text,
  add column if not exists image_url text,
  add column if not exists audience_departments jsonb,
  add column if not exists published_by text,
  add column if not exists published_at timestamptz,
  add column if not exists edited_by text,
  add column if not exists edited_at timestamptz,
  add column if not exists notify_seq integer not null default 0;

update public.hr_announcements set published_at = coalesce(published_at, created_at), published_by = coalesce(published_by, created_by);

alter table public.hr_announcement_reads
  add column if not exists employee_id uuid,
  add column if not exists acknowledged_at timestamptz;
create unique index if not exists uq_hr_ann_reads_ann_email on public.hr_announcement_reads (announcement_id, lower(employee_email));

create table if not exists public.hr_announcement_reactions (
  id bigserial primary key,
  announcement_id bigint not null references public.hr_announcements(id) on delete cascade,
  employee_id uuid,
  employee_email text not null,
  emoji text not null check (emoji in ('👍','❤️','👏','✅','🙏','🎉')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_hr_ann_reaction_one_per_employee on public.hr_announcement_reactions (announcement_id, lower(employee_email));

create table if not exists public.hr_announcement_replies (
  id bigserial primary key,
  announcement_id bigint not null references public.hr_announcements(id) on delete cascade,
  employee_id uuid,
  employee_email text not null,
  author_name text,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  hidden_at timestamptz,
  hidden_by text
);
create index if not exists idx_hr_ann_replies_ann on public.hr_announcement_replies (announcement_id, created_at);

-- Same access model as every other HR table in this project (anon key, no per-user auth).
alter table public.hr_announcement_reactions enable row level security;
alter table public.hr_announcement_replies enable row level security;
do $$ begin
  create policy "allow all - hr_announcement_reactions" on public.hr_announcement_reactions for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "allow all - hr_announcement_replies" on public.hr_announcement_replies for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Realtime delivery.
do $$ declare t text; begin
  foreach t in array array['hr_announcements','hr_announcement_reads','hr_announcement_reactions','hr_announcement_replies'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
