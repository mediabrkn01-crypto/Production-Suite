// Speech-to-text behind one interface. Default: Sarvam Saaras v4 over the streaming
// WebSocket (wss://api.sarvam.ai/speech-to-text/ws), codemix mode so Malayalam + English
// (Manglish) comes back as written Malayalam with English ERP terms kept in English.
import { config } from "./config.ts";

export interface SttOptions {
  /** BCP-47 hint; ml-IN covers Malayalam and Malayalam-English code-mix. */
  languageCode?: string;
  /** Company terms / names to bias recognition (max 50, ≤64 chars each). */
  keyterms?: string[];
  sampleRate?: 16000 | 8000;
}
export interface SttCallbacks {
  onSpeechStart?: () => void;
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
}
export interface SttResult { text: string; languageCode: string | null }

export interface SttProvider {
  readonly name: string;
  /** audio = raw PCM s16le mono at opts.sampleRate (a WAV container is also accepted). */
  transcribe(audio: Uint8Array | AsyncIterable<Uint8Array>, opts: SttOptions, cb?: SttCallbacks): Promise<SttResult>;
}

export class SttError extends Error {
  constructor(public code: "STT_CONFIG" | "STT_UNAVAILABLE" | "STT_EMPTY" | "STT_TIMEOUT", message: string) { super(message); }
}

export const BASE_KEYTERMS = [
  "Broken English", "Academic", "Fluency Coach", "Student Counselor", "Class Coordinator", "Batch",
  "Attendance", "LOP", "Payroll", "Payslip", "Trainer", "Leave", "Enrollment", "Lead", "Counselor",
  "Talk Club", "Elite", "IELTS", "Media", "Sales", "HR",
];

/** Strip a WAV header if present, returning raw PCM. */
function pcmOf(buf: Uint8Array): Uint8Array {
  if (buf.length > 44 && String.fromCharCode(...buf.slice(0, 4)) === "RIFF") {
    for (let i = 12; i + 8 < buf.length;) {
      const id = String.fromCharCode(...buf.slice(i, i + 4));
      const size = new DataView(buf.buffer, buf.byteOffset + i + 4, 4).getUint32(0, true);
      if (id === "data") return buf.slice(i + 8, i + 8 + size);
      i += 8 + size + (size % 2);
    }
  }
  return buf;
}
function b64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export class SarvamSttProvider implements SttProvider {
  readonly name = "sarvam-saaras-v4";

  constructor() {
    if (!config.sarvamApiKey) throw new SttError("STT_CONFIG", "SARVAM_API_KEY is not set");
  }

  async transcribe(audio: Uint8Array | AsyncIterable<Uint8Array>, opts: SttOptions, cb: SttCallbacks = {}): Promise<SttResult> {
    // Buffer the utterance (bounded: 60 s of 16 kHz PCM ≈ 1.9 MB) so one reconnect can replay it.
    const chunks: Uint8Array[] = [];
    if (audio instanceof Uint8Array) chunks.push(audio);
    else for await (const c of audio) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 2_000_000) break; }
    const all = new Uint8Array(chunks.reduce((n, x) => n + x.length, 0));
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const pcm = pcmOf(all);
    if (pcm.length < 3200) throw new SttError("STT_EMPTY", "audio too short");

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.once(pcm, opts, cb); } catch (e) {
        lastErr = e;
        if (e instanceof SttError && (e.code === "STT_EMPTY" || e.code === "STT_CONFIG")) throw e;
      }
    }
    throw lastErr instanceof SttError ? lastErr : new SttError("STT_UNAVAILABLE", String(lastErr));
  }

  private once(pcm: Uint8Array, opts: SttOptions, cb: SttCallbacks): Promise<SttResult> {
    const rate = opts.sampleRate || 16000;
    const q = new URLSearchParams({
      model: "saaras:v4", mode: "codemix", "language-code": opts.languageCode || "ml-IN",
      sample_rate: String(rate), input_audio_codec: "pcm_s16le", vad_signals: "true", flush_signal: "true",
    });
    const terms = [...new Set((opts.keyterms || BASE_KEYTERMS).map((t) => t.trim()).filter((t) => t && t.length <= 64))].slice(0, 50);
    if (terms.length) q.set("keyterms", JSON.stringify(terms));
    return new Promise<SttResult>((resolve, reject) => {
      // deno-lint-ignore no-explicit-any
      const ws = new (WebSocket as any)(`${config.sarvamWsBase}/speech-to-text/ws?${q}`, { headers: { "Api-Subscription-Key": config.sarvamApiKey } }) as WebSocket;
      const parts: string[] = [];
      let lang: string | null = null, flushed = false, settled = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const hard = setTimeout(() => finish(parts.length ? null : new SttError("STT_TIMEOUT", "no transcript")), 15_000);
      function finish(err: Error | null) {
        if (settled) return; settled = true;
        clearTimeout(hard); clearTimeout(idle);
        try { ws.close(); } catch { /* ignore */ }
        const text = parts.join(" ").replace(/\s+/g, " ").trim();
        if (err) return reject(err);
        if (!text) return reject(new SttError("STT_EMPTY", "no speech recognised"));
        cb.onFinalTranscript?.(text);
        resolve({ text, languageCode: lang });
      }
      ws.onopen = () => {
        // ~100 ms frames; the server segments with its own VAD.
        const frame = rate / 10 * 2;
        for (let i = 0; i < pcm.length; i += frame) {
          ws.send(JSON.stringify({ audio: { data: b64(pcm.subarray(i, i + frame)), sample_rate: String(rate), encoding: "audio/wav" } }));
        }
        ws.send(JSON.stringify({ type: "flush" }));
        flushed = true;
        idle = setTimeout(() => finish(null), 4000); // nothing after flush → done with what we have
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { type?: string; data?: Record<string, unknown> };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.type === "events" && m.data?.signal_type === "START_SPEECH") cb.onSpeechStart?.();
        else if (m.type === "data") {
          const t = String(m.data?.transcript || "").trim();
          if (t) { parts.push(t); lang = (m.data?.language_code as string) || lang; cb.onPartialTranscript?.(parts.join(" ")); }
          if (flushed) { clearTimeout(idle); idle = setTimeout(() => finish(null), 350); }
        } else if (m.type === "error") {
          finish(new SttError("STT_UNAVAILABLE", String(m.data?.error || "stt error")));
        }
      };
      ws.onerror = () => finish(new SttError("STT_UNAVAILABLE", "stt socket error"));
      ws.onclose = () => { if (!settled) finish(parts.length ? null : new SttError("STT_UNAVAILABLE", "stt socket closed")); };
    });
  }
}

export function createSttProvider(): SttProvider {
  return new SarvamSttProvider();
}
