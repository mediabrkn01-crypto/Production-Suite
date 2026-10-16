// Jarvis REALTIME session — one WebSocket per open Jarvis conversation (full duplex).
//
// client → server
//   {type:"hello", token, session, rate}   ERP session token (same sign-in, no Jarvis login)
//   {type:"speech_start"}                  client VAD heard the user (also = barge-in while Jarvis talks)
//   <binary>                               PCM s16le mono frames, streamed while the user speaks
//   {type:"speech_end", vad_ms}            client VAD end-of-utterance → finish STT → answer
//   {type:"cancel"}                        the "speech" was noise → drop it
//   {type:"interrupt"}                     stop the current answer now
//   {type:"text", text}                    typed question
//   {type:"ping"}
// server → client: {type:"ready"} · {type:"stt.speech_end"} · voice-engine events (see
// voiceEngine.ts), every event tagged with `turn` so the client ignores anything stale.
//
// Barge-in: a new speech_start / interrupt aborts the running turn's AbortController — the LLM
// stream, the ERP-tool wait, every TTS socket and the audio not yet sent stop immediately, and
// the client drops anything still in flight for the old turn. The old answer never resumes.
import { JarvisAuthError, resolveAuthContext, type JarvisAuthContext } from "./auth.ts";
import { config } from "./config.ts";
import { loadHistory, type Turn } from "./jarvisAudit.ts";
import { SarvamLiveStt } from "./sttLive.ts";
import { createSttProvider, SttError } from "./sttProvider.ts";
import { keyterms, MESSAGES, runTurn, type JarvisEvent, type TurnInput } from "./voiceEngine.ts";

export interface RealtimeDeps {
  resolveAuth?: (token: string) => Promise<JarvisAuthContext>;
  createLiveStt?: (rate: 16000 | 8000, terms: string[], ev: ConstructorParameters<typeof SarvamLiveStt>[2]) => Pick<SarvamLiveStt, "push" | "finish" | "cancel" | "firstPartialAt" | "openedAt" | "failed">;
  runTurn?: (input: TurnInput) => Promise<void>;
  loadHistory?: (auth: JarvisAuthContext, session: string) => Promise<Turn[]>;
}

const MAX_TURNS_PER_MINUTE = 30;
const MAX_UTTERANCE_BYTES = 2_000_000;   // ≈ 60 s at 16 kHz

export function handleRealtime(ws: WebSocket, deps: RealtimeDeps = {}) {
  const resolve = deps.resolveAuth || ((token: string) => resolveAuthContext(new Request("http://jarvis.local/", { headers: { "x-erp-session": token } })));
  const liveStt = deps.createLiveStt || ((rate, terms, ev) => new SarvamLiveStt(rate, terms, ev));
  const turnFn = deps.runTurn || runTurn;
  const history = deps.loadHistory || loadHistory;

  let auth: JarvisAuthContext | null = null, authAt = 0, token = "";
  let sessionId = "default", rate: 16000 | 8000 = 16000;
  let turn = 0;
  let utt: { id: number; stt: ReturnType<RealtimeDeps["createLiveStt"] & {}> | null; chunks: Uint8Array[]; bytes: number; startedAt: number; ended: boolean } | null = null;
  let running: { id: number; ctl: AbortController } | null = null;
  let mem: Turn[] | null = null;
  const recent: number[] = [];
  let terms: string[] = [];

  const send = (o: unknown) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); } catch { /* closed */ } };
  const tagged = (id: number) => (e: JarvisEvent) => { if (id === turn) send({ ...e, turn: id }); };

  async function ensureAuth(): Promise<JarvisAuthContext> {
    // Identity + access are re-read from HR at most every 5 minutes (exits / role changes apply fast).
    if (!auth || Date.now() - authAt > 300_000) { auth = await resolve(token); authAt = Date.now(); }
    return auth;
  }
  function interrupt(reason: string) {
    if (running) {
      running.ctl.abort(reason);
      send({ type: "state", state: "IDLE", turn: running.id, interrupted: true });
      running = null;
    }
  }
  function dropUtterance() { if (utt) { utt.stt?.cancel(); utt = null; } }

  function startUtterance() {
    interrupt("barge-in");
    dropUtterance();
    turn++;
    const id = turn;
    let stt: ReturnType<RealtimeDeps["createLiveStt"] & {}> | null = null;
    try {
      stt = liveStt(rate, terms, {
        onPartial: (text) => { if (utt?.id === id) send({ type: "transcript.partial", text, turn: id }); },
        onSpeechEnd: () => { if (utt?.id === id) send({ type: "stt.speech_end", turn: id }); },
      });
    } catch (e) { console.error("[jarvis-rt] live stt:", e instanceof Error ? e.message : e); }
    utt = { id, stt, chunks: [], bytes: 0, startedAt: Date.now(), ended: false };
    send({ type: "state", state: "LISTENING", turn: id });
  }

  async function endUtterance(vadMs?: number) {
    const u = utt; if (!u || u.ended) return;
    u.ended = true;
    const id = u.id, endAt = Date.now();
    send({ type: "state", state: "TRANSCRIBING", turn: id });
    let text = "", sttMs = 0, firstPartial = 0;
    try {
      if (u.stt && !u.stt.failed) {
        const r = await u.stt.finish();
        text = r.text; firstPartial = u.stt.firstPartialAt ? u.stt.firstPartialAt - u.startedAt : 0;
      } else throw new SttError("STT_UNAVAILABLE", "live stt unavailable");
    } catch (e) {
      // Live socket failed → transcribe the buffered utterance once (old path) instead of failing.
      if (!(e instanceof SttError && e.code === "STT_EMPTY") && u.bytes >= 3200) {
        try {
          const all = new Uint8Array(u.bytes); let o = 0; for (const c of u.chunks) { all.set(c, o); o += c.length; }
          text = (await createSttProvider().transcribe(all, { languageCode: "ml-IN", keyterms: terms, sampleRate: rate })).text;
        } catch { /* fall through */ }
      }
    }
    sttMs = Date.now() - endAt;
    if (utt?.id === id) utt = null;
    if (id !== turn) return;                      // a newer utterance already started
    if (!text) {
      send({ type: "error", code: "STT_EMPTY", message: MESSAGES.stt, turn: id });
      send({ type: "state", state: "IDLE", turn: id });
      return;
    }
    send({ type: "transcript.final", text, turn: id });
    await answer(id, text, { vad_end: vadMs || 0, stt_first_partial: firstPartial, stt_final: sttMs }, "voice");
  }

  async function answer(id: number, text: string, pre: Record<string, number>, mode: "voice" | "text") {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length >= MAX_TURNS_PER_MINUTE) { send({ type: "error", code: "RATE_LIMIT", message: "Too many requests — give Jarvis a moment.", turn: id }); return; }
    recent.push(now);
    let a: JarvisAuthContext;
    try { a = await ensureAuth(); } catch (e) { return authFail(e); }
    if (!mem) { try { mem = await history(a, sessionId); } catch { mem = []; } }
    const ctl = new AbortController();
    running = { id, ctl };
    try {
      await turnFn({
        auth: a, sessionId, text, wantAudio: true, emit: tagged(id), signal: ctl.signal, history: mem.slice(-config.historyTurns * 2),
        pre, inputMode: mode,
        onTurn: (u, ans, interrupted) => {
          mem!.push({ role: "user", content: u }, { role: "assistant", content: interrupted ? (ans ? ans + " [interrupted by the user]" : "[interrupted by the user before answering]") : ans });
          if (mem!.length > config.historyTurns * 2) mem!.splice(0, mem!.length - config.historyTurns * 2);
        },
      });
    } catch (e) {
      console.error("[jarvis-rt] turn:", e instanceof Error ? e.message : e);
      if (id === turn) { send({ type: "error", code: "INTERNAL", message: "Something went wrong. Please try again.", turn: id }); send({ type: "state", state: "IDLE", turn: id }); }
    } finally { if (running?.id === id) running = null; }
  }

  function authFail(e: unknown) {
    const expired = e instanceof JarvisAuthError;
    send({ type: "error", code: expired ? e.code : "AUTH", message: expired ? e.message : "Jarvis could not verify your sign-in right now." });
    if (expired) try { ws.close(4401, "session"); } catch { /* ignore */ }
  }

  ws.onmessage = async (ev: MessageEvent) => {
    if (typeof ev.data !== "string") {
      // audio frame
      const u = utt; if (!u || u.ended) return;
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data instanceof Blob ? new Uint8Array(await ev.data.arrayBuffer()) : null;
      if (!buf || u.bytes + buf.length > MAX_UTTERANCE_BYTES) return;
      u.bytes += buf.length; u.chunks.push(buf);
      u.stt?.push(buf);
      return;
    }
    let m: Record<string, unknown>;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "hello": {
        token = String(m.token || ""); sessionId = String(m.session || "default").replace(/[^\w.-]/g, "").slice(0, 64) || "default";
        rate = m.rate === 8000 ? 8000 : 16000;
        try {
          // STT vocabulary loads in the background (cached 10 min) — never delays "ready".
          keyterms().then((kt) => { terms = kt; }).catch(() => {});
          const a = await ensureAuth();
          send({ type: "ready", user: { name: a.name }, turn });
          // Warm the conversation memory while the user is still deciding what to say.
          history(a, sessionId).then((h) => { if (!mem) mem = h; }).catch(() => {});
        } catch (e) { authFail(e); }
        break;
      }
      case "speech_start": if (auth) startUtterance(); break;
      case "speech_end": endUtterance(Number(m.vad_ms) || 0); break;
      case "cancel": if (utt && !utt.ended) { dropUtterance(); send({ type: "state", state: "IDLE", turn }); } break;
      case "interrupt": interrupt("user"); break;
      case "text": {
        if (!auth) break;
        const q = String(m.text || "").slice(0, 1000).trim(); if (!q) break;
        interrupt("new question"); dropUtterance();
        turn++;
        send({ type: "transcript.final", text: q, turn });
        answer(turn, q, {}, "text");
        break;
      }
      case "ping": send({ type: "pong", t: m.t }); break;
    }
  };
  ws.onclose = () => { interrupt("closed"); dropUtterance(); };
  ws.onerror = () => { interrupt("error"); dropUtterance(); };
}
