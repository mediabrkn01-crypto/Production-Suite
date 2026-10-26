-- Monthly Work Archive: every employee can archive their OWN completed work.
-- New scope 'self:<employee id>' (one personal archive per employee per month) next to
-- 'org' and 'dept:<code>'. Additive: only the scope check is widened.
alter table public.work_archives drop constraint if exists work_archives_scope_key_check;
alter table public.work_archives add constraint work_archives_scope_key_check
  check (scope_key = 'org' or scope_key ~ '^dept:[a-z_]+$' or scope_key ~ '^self:[0-9a-fA-F-]{8,}$');
