// Jarvis voice engine — one conversational turn, STREAMED end to end:
//
//   final transcript ─▶ LLM (token stream, read-only ERP tools run in parallel)
//                          │ text deltas
//                          ▼
//                     TtsPipeline (cuts phrases, synthesises ahead, emits audio IN ORDER)
//                          │ mp3 chunks
//                          ▼
//                     client plays chunk 1 while chunk 2 is still being generated
//
// Every stage is cancellable through `signal` (barge-in: the user talks over Jarvis → the
// model call, all queued TTS and anything not yet sent are dropped; nothing old ever resumes).
//
// Events (SSE for the POST endpoint, JSON frames on the realtime socket) — all carry `turn`:
//   state · transcript.partial · transcript.final · status · assistant.delta · assistant.text ·
//   audio.chunk · timing · error · done
import type { JarvisAuthContext } from "./auth.ts";
import { adminClient } from "./auth.ts";
import { config } from "./config.ts";
import { executeErpTool, toolDefinitions } from "./erpTools.ts";
import { loadHistory, saveTurns, type ToolCallRecord, type Turn, writeAudit } from "./jarvisAudit.ts";
import { KNOWLEDGE_INDEX } from "./knowledge.ts";
import { createLlmProvider, LlmError } from "./llmProvider.ts";
import { BASE_KEYTERMS, createSttProvider, SttError } from "./sttProvider.ts";
import { createTtsProvider, detectAnswerLanguage, speakable, TtsPipeline } from "./ttsProvider.ts";
import { addDays, tzDate } from "./time.ts";

export type JarvisState = "IDLE" | "LISTENING" | "TRANSCRIBING" | "THINKING" | "CHECKING_ERP" | "CHECKING_CRM" | "SPEAKING" | "ERROR";
export type JarvisEvent = { turn?: number } & (
  | { type: "state"; state: JarvisState }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "status"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.text"; text: string; language: string }
  | { type: "audio.chunk"; audio: string; mimeType: string; seq: number }
  | { type: "timing"; stage: string; ms: number }
  | { type: "error"; code: string; message: string }
  | { type: "done"; stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms: number; tts: boolean; interrupted?: boolean; timings?: Record<string, number> });

export interface TurnInput {
  auth: JarvisAuthContext;
  sessionId: string;
  audio?: Uint8Array;
  text?: string;
  sampleRate?: 16000 | 8000;
  wantAudio?: boolean;
  emit: (e: JarvisEvent) => void;
  /** Barge-in / client gone. */
  signal?: AbortSignal;
  /** Conversation history held by the realtime session (skips the DB read). */
  history?: Turn[];
  /** Stage timings measured before this function (realtime STT). */
  pre?: Record<string, number>;
  /** "voice" (realtime or upload) vs typed. */
  inputMode?: "voice" | "text";
  /** Called with the final user/assistant texts (realtime keeps them in memory). */
  onTurn?: (user: string, assistant: string, interrupted: boolean) => void;
}

export const MESSAGES = {
  stt: "I couldn't hear that clearly. Please try again.",
  erp: "I couldn't reach the ERP data right now.",
  llm: "I'm having trouble thinking right now. Please try again in a moment.",
  readOnly: "I can retrieve and explain that information, but I can't make ERP changes — please do that in the ERP screen.",
};

const STATUS: Record<string, string> = {
  get_todays_classes: "Checking Academic classes…", get_unmarked_class_attendance: "Checking class attendance…", get_upcoming_batches: "Checking upcoming batches…",
  get_batch_details: "Checking the batch…", get_student_info: "Checking the student…", get_live_class_status: "Checking Live Classes…",
  get_trainers_on_leave: "Checking trainer leave…", get_leave_status: "Checking HR leave…", get_employee_attendance_summary: "Checking HR attendance…",
  get_holidays: "Checking holidays…", get_payroll_summary: "Checking payroll…", get_company_assets: "Checking company assets…",
  get_sales_summary: "Checking Sales…", get_top_performing_counselor: "Checking Sales…", query_crm_leads: "Checking the CRM…",
  get_work_tasks: "Checking work tasks…", get_company_status: "Checking every department…", get_erp_metrics: "Checking department metrics…",
  get_my_tasks: "Checking your tasks…", get_my_attendance_and_leave: "Checking your attendance…", get_my_notifications: "Checking notifications…",
  get_announcements: "Checking announcements…", search_erp: "Searching the ERP…", get_erp_knowledge: "Looking that up…",
};

function systemPrompt(auth: JarvisAuthContext): string {
  const today = tzDate();
  const day = new Date(today + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const P = auth.permissions;
  const access = [
    P.includes("org") ? "organisation-wide read access across all departments (attendance, leave, payroll, classes, sales, work, assets)" : "",
    !P.includes("org") && P.includes("academic.all") ? "all Academic classes, batches, students and trainer leave" : "",
    P.includes("academic.own") && !P.includes("academic.all") ? "their OWN classes, batches and students only" : "",
    !P.includes("org") && P.includes("hr.attendance") ? "company HR attendance, leave and holidays" : "",
    !P.includes("org") && P.includes("hr.payroll") ? "payroll and company assets for any employee" : "",
    !P.includes("org") && P.includes("sales.all") ? "the whole Sales team and CRM" : "",
    P.includes("sales.own") ? "their OWN leads and enrolments only" : "",
    !P.includes("org") && P.includes("media.all") ? "the Media / Production work pipeline" : "",
    "their own tasks, attendance, leave, payslip, assets, notifications and announcements",
  ].filter(Boolean).join("; ");
  return `You are Jarvis, the fast, conversational AI assistant inside the Broken English ERP — like a sharp colleague who knows every module.

TOOLS. For any live company information (classes, attendance, leave, employees, holidays, payroll, batches, students, leads, sales, work tasks, assets, notifications) you MUST call ERP tools before answering — never answer live data from memory or from earlier turns without re-checking. Call several tools in parallel when independent. For "how is the company doing / today's status" use get_company_status. For "how does X work / what happens when / why is" questions, call get_erp_knowledge (ERP rules) and, when about a specific person, batch or day, the data tools as well, then reason over both. If you don't know which module something belongs to, use search_erp. Topics in the ERP knowledge base: ${KNOWLEDGE_INDEX}.

NEVER INVENT DATA. Never make up numbers, names, classes, leave, salaries or attendance. If a tool fails or returns no records, say so plainly ("I couldn't retrieve today's Sales data right now." / "No one is on leave today."). If something is outside the speaker's access, say they don't have access to it in the ERP.

READ-ONLY. You cannot create, change, approve, reject, delete, assign, move, mark, send or pay anything. For such requests reply: "${MESSAGES.readOnly}" (in Malayalam if they spoke Malayalam), and say which ERP screen does it if you know.

TIME. Company timezone Asia/Kolkata. Today is ${day} (${today}); tomorrow is ${addDays(today, 1)}. Pass dates to tools as today / tomorrow / yesterday / this_week / last_week / this_month / last_month / last_N_days / next_N_days or YYYY-MM-DD. "This month so far" for counselor rankings = timeframe_days ${Number(today.slice(8, 10))}.

SPEAKER. ${auth.name}${auth.designation ? ", " + auth.designation : ""}${auth.department ? " (" + auth.department + ")" : ""}. Access: ${access}. "I", "me", "my" mean this person — never ask who they are. Speak TO them in the second person.

CONVERSATION. Follow-ups refer to the previous question and its answer: "how many are Mariyam's?", "only unfinished ones", "which department are they from?", "which three?" — reuse that context (same date, same list, same people) without asking the user to repeat it. If the user interrupted you, answer the NEW request.

LANGUAGE. Reply in the language the user used: English → natural English; Malayalam → natural Malayalam; mixed Malayalam-English (Manglish) → Malayalam script keeping familiar ERP words in English (class, batch, trainer, leave, attendance, LOP, lead, payroll). Write names as in the ERP data.

VOICE STYLE. This is spoken. Be brief and natural: usually 1–3 short sentences, key answer first, then the most important names or numbers ("Yes. Three classes still have attendance pending. The oldest is the 11 AM class."). No markdown, bullets, tables, emoji, IDs or UUIDs. For long lists give the top few and say how many more; the user can ask for the rest. Spell times naturally ("11 in the morning", "രാവിലെ 11"). If a lookup will take a moment you may begin with a very short phrase such as "Let me check." — never more filler than that.`;
}

const WRITE_INTENT = /^\s*(please\s+|jarvis[, ]+)?(approve|reject|decline|delete|remove|cancel|change|update|edit|modify|move|transfer|assign|reassign|create|add|mark|set|pay|deduct|grant|revoke|send)\b/i;

let _keyterms: { at: number; terms: string[] } | null = null;
/** Company vocabulary for STT: base terms + live trainer and course names (cached 10 min). */
export async function keyterms(): Promise<string[]> {
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
  const { auth } = input;
  const signal = input.signal;
  const emit = (e: JarvisEvent) => { if (!signal?.aborted) input.emit(e); };
  const t0 = Date.now();
  const T: Record<string, number> = { ...(input.pre || {}) };
  const mark = (stage: string, ms: number) => { T[stage] = ms; emit({ type: "timing", stage, ms }); };
  const timings: { stt_ms?: number; llm_ms?: number; tts_ms?: number; total_ms: number } = { total_ms: 0 };
  const tools: ToolCallRecord[] = [];
  let transcript = (input.text || "").trim();
  let answer = "", language: string | null = null, success = false, errorCode: string | null = null;
  let llmName = "", llmModel = "", spoke = false, interrupted = false;
  let pipe: TtsPipeline | null = null;

  try {
    // 1 — speech → final transcript (legacy upload path; the realtime socket transcribes live)
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
      } finally { timings.stt_ms = Date.now() - s0; mark("stt_final", timings.stt_ms); }
      emit({ type: "transcript.final", text: transcript });
    }
    if (!transcript) { errorCode = "EMPTY"; emit({ type: "error", code: "EMPTY", message: MESSAGES.stt }); emit({ type: "state", state: "ERROR" }); return; }

    // 2 — streaming speech pipeline, fed by the LLM token stream
    const wantAudio = input.wantAudio !== false;
    let seq = 0, streamed = "";
    if (wantAudio) {
      try {
        pipe = new TtsPipeline(createTtsProvider(), () => detectAnswerLanguage(streamed || answer), (c) => {
          if (signal?.aborted) return;
          if (!spoke) { spoke = true; mark("tts_first_audio", Date.now() - t0); emit({ type: "state", state: "SPEAKING" }); }
          emit({ type: "audio.chunk", audio: c.audioBase64, mimeType: c.mimeType, seq: seq++ });
        });
        signal?.addEventListener("abort", () => pipe?.abort(), { once: true });
      } catch (e) { console.error("[jarvis] tts init:", e instanceof Error ? e.message : e); pipe = null; }
    }

    // 3 — LLM + ERP tools (read-only guard first: no LLM round-trip for an obvious write)
    emit({ type: "state", state: "THINKING" });
    const l0 = Date.now();
    if (WRITE_INTENT.test(transcript)) {
      answer = MESSAGES.readOnly;
      emit({ type: "assistant.delta", text: answer });
      pipe?.push(answer);
    } else {
      try {
        const llm = createLlmProvider();
        llmName = llm.name; llmModel = llm.model;
        const history = input.history ?? await loadHistory(auth, input.sessionId);
        const res = await llm.answer({
          system: systemPrompt(auth), history, userText: transcript,
          tools: toolDefinitions(auth), maxToolCalls: config.maxToolCalls, signal,
          onFirstToken: () => mark("llm_first_token", Date.now() - l0),
          onText: (d) => { streamed += d; emit({ type: "assistant.delta", text: d }); pipe?.push(d); },
          executeTools: async (calls) => {
            emit({ type: "state", state: calls.some((c) => c.name === "query_crm_leads") ? "CHECKING_CRM" : "CHECKING_ERP" });
            emit({ type: "status", text: calls.length > 1 ? "Checking " + [...new Set(calls.map((c) => (STATUS[c.name] || "ERP").replace(/^Checking |…$/g, "")))].join(", ") + "…" : (STATUS[calls[0].name] || "Checking the ERP…") });
            const e0 = Date.now();
            const out = await Promise.all(calls.map(async (c) => {
              const s = Date.now();
              const r = await executeErpTool(c.name, c.args, auth);
              tools.push({ name: c.name, args: c.args, ok: r.ok, ms: Date.now() - s, error: r.ok ? undefined : r.error });
              return r;
            }));
            mark("erp_tools", (T.erp_tools || 0) + (Date.now() - e0));
            emit({ type: "state", state: "THINKING" });
            return out;
          },
        });
        answer = res.text;
      } catch (e) {
        if (e instanceof LlmError && e.code === "LLM_ABORTED") { interrupted = true; answer = streamed; }
        else {
          errorCode = e instanceof LlmError ? e.code : "LLM_UNAVAILABLE";
          console.error("[jarvis] llm:", e instanceof Error ? e.message : e);
          answer = tools.length && tools.every((t) => !t.ok) ? MESSAGES.erp : MESSAGES.llm;
          if (!streamed) { emit({ type: "assistant.delta", text: answer }); pipe?.push(answer); }
        }
      }
    }
    timings.llm_ms = Date.now() - l0;
    if (signal?.aborted) interrupted = true;
    answer = speakable(answer) || answer;
    const lang = detectAnswerLanguage(answer);
    if (!interrupted) emit({ type: "assistant.text", text: answer, language: lang });
    success = !errorCode && !interrupted;

    // 4 — finish speech (text stays on screen even if TTS fails)
    if (pipe && !interrupted) {
      const s0 = Date.now();
      pipe.end();
      await pipe.done;
      timings.tts_ms = Date.now() - s0;
      if (pipe.failed && !spoke) emit({ type: "error", code: "TTS_UNAVAILABLE", message: "Voice playback is unavailable right now — showing the answer as text." });
    }
    if (input.onTurn) input.onTurn(transcript, answer, interrupted);
    if (answer && (success || interrupted)) saveTurns(auth, input.sessionId, transcript, interrupted ? answer + " [interrupted by the user]" : answer).catch(() => {});
  } finally {
    pipe?.abort();
    timings.total_ms = Date.now() - t0;
    if (!signal?.aborted) {
      input.emit({ type: "done", ...timings, tts: spoke, interrupted, timings: T });
      input.emit({ type: "state", state: "IDLE" });
    }
    await writeAudit(auth, {
      sessionId: input.sessionId, transcript, responseText: answer, language: language || (answer ? detectAnswerLanguage(answer) : null),
      tools, success, errorCode: interrupted ? "INTERRUPTED" : errorCode, timings, provider: llmName || config.llmProvider, model: llmModel,
      input: input.inputMode || (input.audio ? "voice" : "text"), stages: T,
    });
  }
}
