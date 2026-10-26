-- ============================================================================
-- Monthly Completed Work Archive (Media Suite → Completed Work History)
--
-- One archive per month ('YYYY-MM', unique): processing the same month again REUSES the
-- archive, its Drive folders and every item already archived (no duplicate archive, no
-- duplicate files). Items are keyed (archive, assignment, deliverable URL) so a re-run only
-- adds work completed since, and "Retry failed" only resends failed items.
--
-- Drive work is done by the existing Apps Script web app (the Broken English Google account
-- that already owns uploaded deliverables) via the work-archive edge function. Originals are
-- never moved, renamed or modified: Drive deliverables get SHORTCUTS, ERP-storage files get
-- COPIES, other links are listed in the index Sheet.
--
-- Server-only tables: RLS on with no policies — the browser reads them through the
-- work-archive edge function (ERP session + role checked there), never directly.
-- ============================================================================

create table if not exists public.work_archives (
  id                uuid primary key default gen_random_uuid(),
  month             text not null unique check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status            text not null default 'draft'
                    check (status in ('draft', 'running', 'partial', 'completed', 'failed')),
  root_folder_id    text,
  year_folder_id    text,
  month_folder_id   text,
  folder_url        text,
  sheet_id          text,
  sheet_url         text,
  totals            jsonb not null default '{}'::jsonb,
  shared_with       jsonb not null default '[]'::jsonb,
  last_error        text,
  created_by        text,
  created_by_email  text,
  created_at        timestamptz not null default now(),
  updated_by        text,
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create table if not exists public.work_archive_projects (
  archive_id   uuid not null references public.work_archives(id) on delete cascade,
  project_key  text not null,              -- work_projects.id, or 'task-<assignment id>' for single work
  title        text,
  folder_id    text,
  folder_url   text,
  primary key (archive_id, project_key)
);

create table if not exists public.work_archive_items (
  id               uuid primary key default gen_random_uuid(),
  archive_id       uuid not null references public.work_archives(id) on delete cascade,
  assignment_id    bigint not null,
  project_key      text not null,
  project_title    text,
  category         text,
  creator          text,
  completed_on     date,
  deliverable_name text not null,
  source_url       text,
  file_key         text not null,           -- md5(source_url) — or 'missing' / 'no-output'
  kind             text not null check (kind in ('drive_file', 'drive_folder', 'storage', 'link', 'missing', 'no_output')),
  status           text not null default 'pending'
                   check (status in ('pending', 'done', 'failed', 'link', 'missing', 'no_output')),
  drive_item_id    text,
  drive_url        text,
  attempts         int not null default 0,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (archive_id, assignment_id, file_key)
);
create index if not exists idx_work_archive_items_status on public.work_archive_items (archive_id, status);

alter table public.work_archives         enable row level security;
alter table public.work_archive_projects enable row level security;
alter table public.work_archive_items    enable row level security;
-- No policies on purpose: service role only (work-archive edge function).
revoke all on public.work_archives, public.work_archive_projects, public.work_archive_items from anon, authenticated;
