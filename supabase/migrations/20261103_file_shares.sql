-- ════════════════════════════════════════════════════════════════════════════
-- INTERNAL FILE SHARING — "Send" approved work (and, later, new uploads) to ERP people.
--
--   erp_file_shares             one row per SEND (what was sent, by whom, the note)
--   erp_file_share_recipients   one row per RECIPIENT of that send — each with its own
--                               viewed / downloaded state and forwarding permission
--
-- No file is ever copied. files[] holds POINTERS to the one stored delivery
-- ({name, url} of the approved work's existing delivery entry; later {name, path} for
-- uploads). Sending a 200 MB video to 10 people = 1 share row + 10 recipient rows.
--
--   source_type  'assignment'  source_id = assignments.id            (Approved Works)
--                'forward'     source_id = erp_file_shares.id        (recipient re-sent it)
--                'upload'      source_id = storage object / batch id (reserved for later)
--
-- Security: RLS on, NO browser policy → the browser key can't read or write these tables.
-- Everything goes through the `share` edge function (ERP session token), which checks who may
-- send, expands departments / heads at send time, and returns file links only to the people
-- a file was sent to. Run any time after 20261023_erp_notifications.sql. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.erp_file_shares (
  id                  uuid primary key default gen_random_uuid(),
  source_type         text not null check (source_type in ('assignment', 'forward', 'upload')),
  source_id           text not null,
  title               text not null,
  item_type           text,
  approved_at         timestamptz,
  files               jsonb not null default '[]'::jsonb,
  sender_employee_id  uuid not null,
  sender_name         text not null,
  sender_division     text,
  message             text check (message is null or char_length(message) <= 600),
  created_at          timestamptz not null default now()
);
create index if not exists idx_file_shares_sender on public.erp_file_shares (sender_employee_id, created_at desc);
create index if not exists idx_file_shares_source on public.erp_file_shares (source_type, source_id);

create table if not exists public.erp_file_share_recipients (
  id                     uuid primary key default gen_random_uuid(),
  share_id               uuid not null references public.erp_file_shares (id) on delete cascade,
  recipient_employee_id  uuid not null,
  recipient_email        text not null,
  via                    text,                 -- how they were picked: person | dept:<code>:all | dept:<code>:head | role:<group>
  forward_allowed        boolean not null default false,
  viewed_at              timestamptz,
  downloaded_at          timestamptz,
  created_at             timestamptz not null default now(),
  unique (share_id, recipient_employee_id)
);
create index if not exists idx_file_share_rcpt_inbox on public.erp_file_share_recipients (recipient_employee_id, created_at desc);

alter table public.erp_file_shares enable row level security;
alter table public.erp_file_share_recipients enable row level security;
-- No policies on purpose: only the service role (the `share` edge function) can touch them.
revoke all on public.erp_file_shares from anon, authenticated;
revoke all on public.erp_file_share_recipients from anon, authenticated;
