// Jarvis voice engine — one conversational turn:
//   audio → STT (final utterance only) → LLM with read-only ERP tools → text → streaming TTS
// and a stream of structured events for the Founder Deck globe:
//   {type:"state", state}  IDLE | LISTENING | TRANSCRIBING | THINKING | CHECKING_ERP |
//                          CHECKING_CRM | SPEAKING | ERROR
//   {type:"transcript.partial"|"transcript.final", text}
//   {type:"assistant.text", text, language}
//   {type:"audio.chunk", audio, mimeType, seq}
//   {type:"error", code, message}          (friendly message only — never a stack trace)
//   {type:"done", ...timings}
import type { JarvisAuthContext } from "./auth.ts";
import { adminClient } from "./auth.ts";
import { config } from "./config.ts";
import { executeErpTool, toolDefinitions } from "./erpTools.ts";
import { loadHistory, saveTurns, type ToolCallRecord, writeAudit } from "./jarvisAudit.ts";
import { createLlmProvider, LlmError } from "./llmProvider.ts";
import { BASE_KEYTERMS, createSttProvider, SttError } from "./sttProvider.ts";
import { createTtsProvider, detectAnswerLanguage, speakable } from "./ttsProvider.ts";
import { addDays, tzDate } from "./time.ts";

export type JarvisState = "IDLE" | "LISTENING" | "TRANSCRIBING" | "THINKING" | "CHECKING_ERP" | "CHECKING_CRM" | "SPEAKING" | "ERROR";
export type JarvisEvent =
  | { type: "state"; state: JarvisState }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "assistant.text"; text: string; language: string }
  | { type: "audio.chunk"; audio: string; mimeType: string; seq: number }
  | { type: "error"; code: string; message: string }
  | { type: "done"; stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms: number; tts: boolean };

export interface TurnInput {
  auth: JarvisAuthContext;
  sessionId: string;
  audio?: Uint8Array;
  text?: string;
  sampleRate?: 16000 | 8000;
  wantAudio?: boolean;
  emit: (e: JarvisEvent) => void;
}

export const MESSAGES = {
  stt: "I couldn't hear that clearly. Please try again.",
  erp: "I couldn't reach the ERP data right now.",
  llm: "I'm having trouble thinking right now. Please try again in a moment.",
  readOnly: "I can retrieve and explain that information, but this version of Jarvis does not make ERP changes.",
};

function systemPrompt(auth: JarvisAuthContext): string {
  const today = tzDate();
  const day = new Date(today + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const scope = auth.scope === "org"
    ? "organisation-wide read access (all departments)"
    : auth.scope === "academic" ? "Academic department read access" : "access to their OWN classes only";
  return `You are Jarvis, the internal AI voice assistant for the Broken English ERP.

You help authorized management understand live company operations. You have read-only ERP tools covering Academic, HR, Sales, Media and CRM.

For any question involving current company information — schedules, classes, attendance, leave, employees, batches, leads, sales, enrollments or performance — you MUST call the appropriate ERP tool before answering. Never answer company data from memory or from earlier turns without re-checking. Never invent company data, names or numbers. If a question needs several facts (for example classes AND leave), call every tool you need — in parallel when they are independent — then combine the results.

You are READ-ONLY. If the user asks you to create, change, approve, reject, delete, assign, move, mark or pay anything, do not call tools for it; reply exactly: "${MESSAGES.readOnly}" (in Malayalam if they spoke Malayalam).

Company timezone: Asia/Kolkata. Today is ${day} (${today}); tomorrow is ${addDays(today, 1)}. Pass dates to tools as today / tomorrow / yesterday / this_week / last_week / this_month / last_month / last_N_days or YYYY-MM-DD. "This month so far" for counselor rankings = timeframe_days ${Number(today.slice(8, 10))}.

The person speaking is ${auth.name} (${auth.role}), with ${scope}.

Language: if the user speaks English, answer in concise natural English. If they speak Malayalam, answer in concise natural Malayalam. If they mix Malayalam and English (Manglish), answer in natural Malayalam script, keeping familiar ERP/business words in English (class, batch, trainer, leave, attendance, LOP, lead, enrollment, counselor). Write names as they appear in the ERP data.

This is a VOICE answer: 1–3 short sentences, no markdown, no bullet points, no tables, no emoji, no IDs or UUIDs. Lead with the key number or answer, then the most important names. Example: "There are 14 classes today. Mariyam has 5, Fasna has 4, and Namratha has 3." For long lists, mention the top few and say how many more. Spell times naturally ("8:30 in the evening" or "രാത്രി 8:30").

If a tool returns no records, say clearly that no matching records were found. If a tool fails or times out, do not guess — say the ERP data could not be checked right now. Follow-up questions ("what about tomorrow?") refer to the topic of the previous question.`;
}

const WRITE_INTENT = /^\s*(please\s+|jarvis[, ]+)?(approve|reject|decline|delete|remove|cancel|change|update|edit|modify|move|transfer|assign|reassign|create|add|mark|set|pay|deduct|grant|revoke)\b/i;

let _keyterms: { at: number; terms: string[] } | null = null;
/** Company vocabulary for STT: base terms + live trainer and course names (cached 10 min). */
async function keyterms(): Promise<string[]> {
  if (_keyterms && Date.now() - _keyterms.at < 600_000) return _keyterms.terms;
  const terms = [...BASE_KEYTERMS];
  try {
    const [t, c] = await Promise.all([
      adminClient().from("trainers").select("name").eq("status", "active"),
      adminClient().from("courses").select("name").neq("active", false),
    ]);
    (t.data || []).forEach((x) => terms.push(String(x.name).split(/\s+/)[0]));
    (c.data || []).forEach((x) => terms.push(String(x.name)));
  } catch { /* base terms only */ }
  _keyterms = { at: Date.now(), terms: [...new Set(terms.filter(Boolean))].slice(0, 50) };
  return _keyterms.terms;
}

export async function runTurn(input: TurnInput): Promise<void> {
  const { auth, emit } = input;
  const t0 = Date.now();
  const timings: { stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms: number } = { total_ms: 0 };
  const tools: ToolCallRecord[] = [];
  let transcript = (input.text || "").trim();
  let answer = "", language: string | null = null, success = false, errorCode: string | null = null;
  let llmName = "", llmModel = "", spoke = false;

  try {
    // 1 — speech → final transcript (partials are shown, never sent to the LLM)
    if (input.audio && !transcript) {
      emit({ type: "state", state: "TRANSCRIBING" });
      const s0 = Date.now();
      try {
        const stt = createSttProvider();
        const r = await stt.transcribe(input.audio, { languageCode: "ml-IN", keyterms: await keyterms(), sampleRate: input.sampleRate || 16000 }, {
          onPartialTranscript: (text) => emit({ type: "transcript.partial", text }),
        });
        transcript = r.text; language = r.languageCode;
      } catch (e) {
        errorCode = e instanceof SttError ? e.code : "STT_UNAVAILABLE";
        console.error("[jarvis] stt:", e instanceof Error ? e.message : e);
        emit({ type: "error", code: errorCode, message: MESSAGES.stt });
        emit({ type: "state", state: "ERROR" });
        return;
      } finally { timings.stt_ms = Date.now() - s0; }
    }
    if (!transcript) { errorCode = "EMPTY"; emit({ type: "error", code: "EMPTY", message: MESSAGES.stt }); emit({ type: "state", state: "ERROR" }); return; }
    emit({ type: "transcript.final", text: transcript });

    // 2 — LLM + ERP tools (read-only guard first: no LLM round-trip for an obvious write)
    emit({ type: "state", state: "THINKING" });
    const l0 = Date.now();
    if (WRITE_INTENT.test(transcript)) {
      answer = MESSAGES.readOnly;
    } else {
      try {
        const llm = createLlmProvider();
        llmName = llm.name; llmModel = llm.model;
        const history = await loadHistory(auth, input.sessionId);
        const res = await llm.answer({
          system: systemPrompt(auth), history, userText: transcript,
          tools: toolDefinitions(auth), maxToolCalls: config.maxToolCalls,
          executeTools: async (calls) => {
            emit({ type: "state", state: "CHECKING_ERP" });
            if (calls.some((c) => c.name === "query_crm_leads")) emit({ type: "state", state: "CHECKING_CRM" });
            const out = await Promise.all(calls.map(async (c) => {
              const s = Date.now();
              const r = await executeErpTool(c.name, c.args, auth);
              tools.push({ name: c.name, args: c.args, ok: r.ok, ms: Date.now() - s, error: r.ok ? undefined : r.error });
              return r;
            }));
            emit({ type: "state", state: "THINKING" });
            return out;
          },
        });
        answer = res.text || "No matching records were found.";
      } catch (e) {
        errorCode = e instanceof LlmError ? e.code : "LLM_UNAVAILABLE";
        console.error("[jarvis] llm:", e instanceof Error ? e.message : e);
        answer = tools.length && tools.every((t) => !t.ok) ? MESSAGES.erp : MESSAGES.llm;
      }
    }
    timings.llm_ms = Date.now() - l0;
    answer = speakable(answer) || answer;   // no markdown on screen or in speech
    const lang = detectAnswerLanguage(answer);
    emit({ type: "assistant.text", text: answer, language: lang });
    success = !errorCode;

    // 3 — streaming speech (text stays on screen even if TTS fails)
    if (input.wantAudio !== false) {
      const s0 = Date.now();
      try {
        const tts = createTtsProvider();
        let seq = 0;
        await tts.stream(answer, lang, (c) => {
          if (!spoke) { spoke = true; emit({ type: "state", state: "SPEAKING" }); }
          emit({ type: "audio.chunk", audio: c.audioBase64, mimeType: c.mimeType, seq: seq++ });
        });
      } catch (e) {
        console.error("[jarvis] tts:", e instanceof Error ? e.message : e);
        emit({ type: "error", code: "TTS_UNAVAILABLE", message: "Voice playback is unavailable right now — showing the answer as text." });
      } finally { timings.tts_ms = Date.now() - s0; }
    }
    if (success) saveTurns(auth, input.sessionId, transcript, answer).catch(() => {});
  } finally {
    timings.total_ms = Date.now() - t0;
    emit({ type: "done", ...timings, tts: spoke });
    emit({ type: "state", state: "IDLE" });
    await writeAudit(auth, {
      sessionId: input.sessionId, transcript, responseText: answer, language: language || (answer ? detectAnswerLanguage(answer) : null),
      tools, success, errorCode, timings, provider: llmName || config.llmProvider, model: llmModel, input: input.audio ? "voice" : "text",
    });
  }
}
