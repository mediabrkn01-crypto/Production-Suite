// Text-to-speech behind one interface. Default: Sarvam Bulbul v3 over the streaming
// WebSocket (wss://api.sarvam.ai/text-to-speech/ws). Audio chunks are forwarded the moment
// they arrive — the caller never waits for the whole file.
import { config } from "./config.ts";

export interface TtsChunk { audioBase64: string; mimeType: string }
export interface TtsProvider {
  readonly name: string;
  stream(text: string, languageCode: "ml-IN" | "en-IN", onChunk: (c: TtsChunk) => void, signal?: AbortSignal): Promise<void>;
}
export class TtsError extends Error {
  constructor(public code: "TTS_CONFIG" | "TTS_UNAVAILABLE" | "TTS_TIMEOUT", message: string) { super(message); }
}

/** ml-IN when the answer is mostly Malayalam script, else en-IN. */
export function detectAnswerLanguage(text: string): "ml-IN" | "en-IN" {
  const ml = (text.match(/[ഀ-ൿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return ml > 0 && ml >= latin * 0.3 ? "ml-IN" : "en-IN";
}

/** Make text speakable: drop markdown, bullets and emoji the model may still emit. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>|]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class SarvamTtsProvider implements TtsProvider {
  readonly name = "sarvam-bulbul-v3";
  constructor() {
    if (!config.sarvamApiKey) throw new TtsError("TTS_CONFIG", "SARVAM_API_KEY is not set");
  }

  stream(text: string, languageCode: "ml-IN" | "en-IN", onChunk: (c: TtsChunk) => void, signal?: AbortSignal): Promise<void> {
    const body = speakable(text);
    if (!body || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      // Key as a subprotocol (edge runtime can't send custom WebSocket headers) — see sttProvider.
      const ws = new WebSocket(`${config.sarvamWsBase}/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`, [`api-subscription-key.${config.sarvamApiKey}`]);
      let settled = false, got = 0;
      const timer = setTimeout(() => done(got ? null : new TtsError("TTS_TIMEOUT", "no audio")), 25_000);
      // Barge-in: close the socket at once; nothing more is emitted for this text.
      const onAbort = () => done(null);
      signal?.addEventListener("abort", onAbort);
      function done(err: Error | null) {
        if (settled) return; settled = true; clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try { ws.close(); } catch { /* ignore */ }
        err ? reject(err) : resolve();
      }
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "config", data: {
          language_code: languageCode, speaker: config.ttsSpeaker, pace: 1.05,
          output_audio_codec: "mp3", output_audio_bitrate: "64k", speech_sample_rate: 24000,
          min_buffer_size: 30, max_chunk_length: 150,
        } }));
        for (let i = 0; i < body.length; i += 2400) ws.send(JSON.stringify({ type: "text", data: { text: body.slice(i, i + 2400) } }));
        ws.send(JSON.stringify({ type: "flush" }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { type?: string; data?: Record<string, unknown> };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "audio" && m.data?.audio) {
          if (signal?.aborted) return;
          got++;
          const ct = String(m.data.content_type || "audio/mpeg");
          onChunk({ audioBase64: String(m.data.audio), mimeType: ct === "audio/mp3" ? "audio/mpeg" : ct });
        } else if (m.type === "event" && m.data?.event_type === "final") done(null);
        else if (m.type === "error") done(new TtsError("TTS_UNAVAILABLE", String(m.data?.message || "tts error")));
      };
      ws.onerror = () => done(new TtsError("TTS_UNAVAILABLE", "tts socket error"));
      ws.onclose = () => done(got ? null : new TtsError("TTS_UNAVAILABLE", "tts socket closed"));
    });
  }
}

export function createTtsProvider(): TtsProvider {
  return new SarvamTtsProvider();
}

// ── Sentence pipeline: speak while the LLM is still writing ──────────────────────────────
// The LLM stream is cut into speakable phrases (sentence end, or a long clause). Each phrase is
// synthesised on its own TTS socket as soon as it is complete — up to 2 in flight — while the
// audio is EMITTED strictly in order (phrase 2 is held until phrase 1 finished). abort() stops
// everything immediately (barge-in) and nothing queued is ever emitted afterwards.
export class TtsPipeline {
  private buf = "";
  private jobs: { text: string; chunks: TtsChunk[]; done: boolean; started: boolean }[] = [];
  private emitIdx = 0;
  private running = 0;
  private ctl = new AbortController();
  private finished = false;
  private resolveAll!: () => void;
  readonly done: Promise<void>;
  firstAudioAt = 0;
  failed = false;
  constructor(private tts: TtsProvider, private lang: () => "ml-IN" | "en-IN", private onChunk: (c: TtsChunk) => void, private maxParallel = 2) {
    this.done = new Promise((r) => { this.resolveAll = r; });
  }
  get aborted() { return this.ctl.signal.aborted; }
  /** Feed streamed LLM text. */
  push(delta: string) {
    if (this.aborted) return;
    this.buf += delta;
    for (;;) {
      const cut = phraseCut(this.buf, this.jobs.length === 0);
      if (cut <= 0) break;
      this.enqueue(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }
  /** LLM finished: flush the tail. */
  end() {
    if (this.aborted) return;
    if (this.buf.trim()) this.enqueue(this.buf);
    this.buf = ""; this.finished = true; this.pump();
  }
  abort() {
    if (this.aborted) return;
    this.ctl.abort(); this.jobs = []; this.finished = true; this.resolveAll();
  }
  private enqueue(text: string) {
    const t = speakable(text);
    if (!t) return;
    this.jobs.push({ text: t, chunks: [], done: false, started: false });
    this.pump();
  }
  private pump() {
    if (this.aborted) return;
    for (const j of this.jobs) {
      if (this.running >= this.maxParallel) break;
      if (j.started) continue;
      j.started = true; this.running++;
      this.tts.stream(j.text, this.lang(), (c) => { j.chunks.push(c); this.flush(); }, this.ctl.signal)
        .catch(() => { this.failed = true; })
        .finally(() => { j.done = true; this.running--; this.flush(); this.pump(); });
    }
    this.flush();
  }
  private flush() {
    if (this.aborted) return;
    while (this.emitIdx < this.jobs.length) {
      const j = this.jobs[this.emitIdx];
      while (j.chunks.length) { if (!this.firstAudioAt) this.firstAudioAt = Date.now(); this.onChunk(j.chunks.shift()!); }
      if (!j.done) return;
      this.emitIdx++;
    }
    if (this.finished && this.emitIdx >= this.jobs.length && this.running === 0) this.resolveAll();
  }
}

/** Where to cut the next speakable phrase (0 = wait for more text). The first phrase may be
 *  short (fast first audio); later ones prefer whole sentences. */
export function phraseCut(s: string, first: boolean): number {
  const min = first ? 18 : 40;
  const re = /[.!?।]["')\]]?\s|[\n]/g;
  let m: RegExpExecArray | null, cut = 0;
  while ((m = re.exec(s))) { const end = m.index + m[0].length; if (end >= min) { cut = end; break; } }
  if (cut) return cut;
  // very long clause without a full stop: cut at a comma / dash once it's long enough
  if (s.length > (first ? 70 : 140)) {
    const k = Math.max(s.lastIndexOf(", "), s.lastIndexOf("; "), s.lastIndexOf(" – "), s.lastIndexOf(" - "));
    if (k > min) return k + 2;
  }
  return 0;
}
