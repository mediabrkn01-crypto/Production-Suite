// Jarvis audit trail + compact conversation memory.
//   jarvis_audit_log — one row per interaction: who (verified user + resolved role), when,
//                      transcript, every tool name + parameters + outcome, success/failure,
//                      latency. No audio is ever stored; no API keys.
//   jarvis_turns     — the last few user/assistant texts per session, so follow-ups such as
//                      "what about tomorrow?" keep their topic. Bounded (JARVIS_HISTORY_TURNS).
// Both tables are RLS-locked (no policies): only this server-side function can read/write them.
import type { JarvisAuthContext } from "./auth.ts";
import { adminClient } from "./auth.ts";
import { config } from "./config.ts";

export interface ToolCallRecord { name: string; args: unknown; ok: boolean; ms: number; error?: string }

export interface AuditEntry {
  sessionId: string;
  transcript: string;
  responseText: string;
  language: string | null;
  tools: ToolCallRecord[];
  success: boolean;
  errorCode?: string | null;
  timings: { stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms: number };
  provider: string;
  model: string;
  input: "voice" | "text";
}

export async function writeAudit(auth: JarvisAuthContext | null, e: AuditEntry): Promise<void> {
  try {
    const { error } = await adminClient().from("jarvis_audit_log").insert({
      auth_user_id: auth?.authUserId ?? null,
      employee_id: auth?.employeeId ?? null,
      email: auth?.email ?? null,
      role: auth?.role ?? null,
      scope: auth ? auth.permissions.join(",") : null,
      session_id: e.sessionId,
      input_mode: e.input,
      transcript: e.transcript.slice(0, 2000),
      response_text: e.responseText.slice(0, 4000),
      language: e.language,
      tools: e.tools,
      success: e.success,
      error_code: e.errorCode ?? null,
      stt_ms: e.timings.stt_ms ?? null,
      llm_ms: e.timings.llm_ms ?? null,
      tts_ms: e.timings.tts_ms ?? null,
      total_ms: e.timings.total_ms,
      llm_provider: e.provider,
      llm_model: e.model,
    });
    if (error) console.error("[jarvis] audit insert failed:", error.message);
  } catch (err) {
    console.error("[jarvis] audit insert failed:", err instanceof Error ? err.message : err);
  }
}

export interface Turn { role: "user" | "assistant"; content: string }

/** Recent turns for this user's session (oldest first), bounded. */
export async function loadHistory(auth: JarvisAuthContext, sessionId: string): Promise<Turn[]> {
  const { data, error } = await adminClient().from("jarvis_turns")
    .select("role,content,created_at")
    .eq("auth_user_id", auth.authUserId).eq("session_id", sessionId)
    .gte("created_at", new Date(Date.now() - 2 * 3600e3).toISOString())   // a session goes cold after 2 h
    .order("created_at", { ascending: false }).limit(config.historyTurns * 2);
  if (error) return [];
  return (data || []).reverse().map((r) => ({ role: r.role, content: r.content }));
}

export async function saveTurns(auth: JarvisAuthContext, sessionId: string, user: string, assistant: string): Promise<void> {
  const now = Date.now();
  const { error } = await adminClient().from("jarvis_turns").insert([
    { auth_user_id: auth.authUserId, session_id: sessionId, role: "user", content: user.slice(0, 2000), created_at: new Date(now).toISOString() },
    { auth_user_id: auth.authUserId, session_id: sessionId, role: "assistant", content: assistant.slice(0, 2000), created_at: new Date(now + 1).toISOString() },
  ]);
  if (error) console.error("[jarvis] history save failed:", error.message);
}
