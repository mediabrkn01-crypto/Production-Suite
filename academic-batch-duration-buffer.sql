-- Adds the two new Create Batch fields (Class Duration, Preparation Buffer) to the
-- consolidated Academic schema in the Media Suite project (fevqnpllmarhoqdzpatq).
-- Safe to re-run.
alter table batches add column if not exists class_duration_minutes integer default 60;
alter table batches add column if not exists prep_buffer_minutes integer default 0;

NOTIFY pgrst, 'reload schema';
