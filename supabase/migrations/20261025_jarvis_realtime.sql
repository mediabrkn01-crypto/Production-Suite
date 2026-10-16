-- Jarvis realtime upgrade: per-stage latency telemetry on every audited turn
-- (mic_ready, vad_end, stt_first_partial, stt_final, llm_first_token, erp_tools,
--  tts_first_audio … in ms). Jarvis keeps working without this column; it just stops
-- recording the breakdown. Safe to re-run.
alter table public.jarvis_audit_log add column if not exists stage_timings jsonb;
create index if not exists idx_jarvis_audit_created on public.jarvis_audit_log (created_at desc);
