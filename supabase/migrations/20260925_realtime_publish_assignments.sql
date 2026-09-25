-- Applied 2026-09-25.
-- Media <-> Production realtime: index.html subscribes to postgres_changes on public.assignments
-- (_beInitRealtime), but the table was never part of the supabase_realtime publication, so no
-- INSERT/UPDATE/DELETE event was ever broadcast and other open screens only caught up on the
-- 3-minute safety poll or a manual refresh (e.g. Media Head "send back for rework" not reaching
-- the creator's Production pipeline). Publishing the table makes those events flow.
-- user_roster is deliberately NOT published (it holds login passwords).
alter publication supabase_realtime add table public.assignments;
