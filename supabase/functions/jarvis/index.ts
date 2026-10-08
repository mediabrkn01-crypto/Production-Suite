// POST /functions/v1/jarvis — one Jarvis voice turn, streamed back as Server-Sent Events.
//
// Transport (works in the Supabase edge runtime — no long-lived socket to the browser):
//   request  Authorization: Bearer <Supabase Auth access token>   (email OTP sign-in)
//            ?session=<client session id>&rate=16000&audio=1|0
//            body = raw PCM s16le mono (Content-Type: application/octet-stream, ≤ 60 s)
//                   or JSON {"text": "..."} for typed questions
//   response text/event-stream, one JSON event per `data:` line (see voiceEngine.ts):
//            state · transcript.partial · transcript.final · assistant.text · audio.chunk ·
//            error · done
// The server holds the Sarvam STT/TTS WebSockets and the LLM tool loop; no API key or ERP
// credential ever reaches the browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext } from "../_shared/jarvis/auth.ts";
import { config } from "../_shared/jarvis/config.ts";
import { type JarvisEvent, runTurn } from "../_shared/jarvis/voiceEngine.ts";

const MAX_AUDIO_BYTES = 2_000_000;      // ≈ 60 s of 16 kHz mono PCM
const MAX_TURNS_PER_MINUTE = 12;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = config.allowedOrigins.includes("*") ? "*" : (config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0] || "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Use POST." });

  // ── who is calling (verified server-side) ──
  let auth;
  try { auth = await resolveAuthContext(req); } catch (e) {
    if (e instanceof JarvisAuthError) return json(req, e.status, { error: e.message, code: e.status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN" });
    console.error("[jarvis] auth:", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "Jarvis could not verify your sign-in right now." });
  }

  // ── simple per-user rate limit (cost guard) ──
  const { count } = await adminClient().from("jarvis_audit_log").select("id", { count: "exact", head: true })
    .eq("auth_user_id", auth.authUserId).gte("created_at", new Date(Date.now() - 60_000).toISOString());
  if ((count ?? 0) >= MAX_TURNS_PER_MINUTE) return json(req, 429, { error: "Too many requests — give Jarvis a moment.", code: "RATE_LIMIT" });

  // ── input ──
  const url = new URL(req.url);
  const sessionId = (url.searchParams.get("session") || "default").replace(/[^\w.-]/g, "").slice(0, 64) || "default";
  const rate = url.searchParams.get("rate") === "8000" ? 8000 : 16000;
  const wantAudio = url.searchParams.get("audio") !== "0";
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  let audio: Uint8Array | undefined, text: string | undefined;
  try {
    if (ctype.includes("application/json")) {
      const body = await req.json();
      text = String(body?.text || "").slice(0, 1000).trim();
      if (!text) return json(req, 400, { error: "Empty question." });
    } else {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (!buf.length) return json(req, 400, { error: "No audio received." });
      if (buf.length > MAX_AUDIO_BYTES) return json(req, 413, { error: "That recording is too long — keep questions under a minute." });
      audio = buf;
    }
  } catch {
    return json(req, 400, { error: "Could not read the request." });
  }

  // ── stream the turn as SSE ──
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: JarvisEvent) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { open = false; }
      };
      const ping = setInterval(() => { if (open) try { controller.enqueue(enc.encode(": ping\n\n")); } catch { open = false; } }, 10_000);
      try {
        await runTurn({ auth: auth!, sessionId, audio, text, sampleRate: rate as 16000 | 8000, wantAudio, emit: send });
      } catch (e) {
        console.error("[jarvis] turn:", e instanceof Error ? e.message : e);
        send({ type: "error", code: "INTERNAL", message: "Something went wrong. Please try again." });
        send({ type: "state", state: "IDLE" });
      } finally {
        clearInterval(ping);
        open = false;
        try { controller.close(); } catch { /* client gone */ }
      }
    },
  });
  return new Response(stream, {
    headers: { ...cors(req), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
});
