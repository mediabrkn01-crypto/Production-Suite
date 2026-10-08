// Jarvis configuration — read ONLY from server-side environment (Supabase function secrets).
// Nothing here is ever sent to the browser.
//
//   SARVAM_API_KEY            Sarvam STT / TTS (and LLM when LLM_PROVIDER=sarvam)
//   ANTHROPIC_API_KEY         Claude (LLM_PROVIDER=anthropic)
//   LLM_PROVIDER              anthropic | sarvam            (default anthropic)
//   CLAUDE_MODEL              default claude-sonnet-4-6
//   SARVAM_LLM_MODEL          default sarvam-105b
//   ERP_INTERNAL_API_BASE     ERP data API base — defaults to this project's SUPABASE_URL
//   ERP_INTERNAL_API_TOKEN    ERP data API token — defaults to SUPABASE_SERVICE_ROLE_KEY
//   JARVIS_MAX_TOOL_CALLS     max tool calls per answer (default 6)
//   JARVIS_TIMEZONE           default Asia/Kolkata (the ERP's business timezone)
//   JARVIS_TTS_SPEAKER        Bulbul v3 speaker (default shubh)
//   JARVIS_HISTORY_TURNS      recent turns kept as context (default 6)
//   JARVIS_ALLOWED_ORIGINS    comma-separated CORS origins (default *)

const env = (k: string, d = ""): string => (Deno.env.get(k) ?? d).trim();
const int = (k: string, d: number): number => {
  const n = parseInt(env(k), 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export type LlmProviderName = "anthropic" | "sarvam";

export const config = {
  sarvamApiKey: env("SARVAM_API_KEY"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  llmProvider: (env("LLM_PROVIDER", "anthropic").toLowerCase() === "sarvam" ? "sarvam" : "anthropic") as LlmProviderName,
  claudeModel: env("CLAUDE_MODEL", "claude-sonnet-4-6"),
  sarvamLlmModel: env("SARVAM_LLM_MODEL", "sarvam-105b"),
  erpApiBase: env("ERP_INTERNAL_API_BASE") || env("SUPABASE_URL"),
  erpApiToken: env("ERP_INTERNAL_API_TOKEN") || env("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseUrl: env("SUPABASE_URL"),
  serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  maxToolCalls: int("JARVIS_MAX_TOOL_CALLS", 6),
  timezone: env("JARVIS_TIMEZONE", "Asia/Kolkata"),
  ttsSpeaker: env("JARVIS_TTS_SPEAKER", "shubh"),
  historyTurns: int("JARVIS_HISTORY_TURNS", 6),
  allowedOrigins: env("JARVIS_ALLOWED_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
  erpTimeoutMs: int("JARVIS_ERP_TIMEOUT_MS", 12000),
  /** Override only for local testing against a mock; production uses Sarvam's hosts. */
  sarvamWsBase: env("SARVAM_WS_BASE", "wss://api.sarvam.ai"),
  // Wake word ("Hey Jarvis") — Picovoice Porcupine runs in the browser; these are only handed
  // to signed-in employees. The AccessKey is a client-side key by Picovoice's design.
  picovoiceAccessKey: env("PICOVOICE_ACCESS_KEY"),
  wakeSensitivity: Math.min(1, Math.max(0, parseFloat(env("JARVIS_WAKE_SENSITIVITY", "0.5")) || 0.5)),
  /** URL/path of the custom "Hey Jarvis" .ppn (Web/WASM). Empty → built-in "Jarvis" keyword. */
  wakeKeywordUrl: env("JARVIS_WAKE_KEYWORD_URL", "jarvis/hey-jarvis_wasm.ppn"),
  sarvamHttpBase: env("SARVAM_HTTP_BASE", "https://api.sarvam.ai"),
};
