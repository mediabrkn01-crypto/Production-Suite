// Live (streaming) speech-to-text for the realtime Jarvis socket.
//
// Old path: the browser recorded the whole question, uploaded it, and only THEN the server
// opened Sarvam STT and replayed the audio (≈1.5 s after the user stopped talking).
// New path: the Sarvam Saaras v4 socket is opened the moment the user starts speaking and every
// 20–40 ms PCM frame is forwarded as it arrives, so recognition runs WHILE the user talks.
// When the user stops (client VAD end-of-speech, or Sarvam's own END_SPEECH signal) we send a
// flush and the final text is normally back within a few hundred ms.
//
// codemix mode: Malayalam + English (Manglish) → Malayalam script with English ERP terms kept.
import { config } from "./config.ts";
import { BASE_KEYTERMS, SttError } from "./sttProvider.ts";

function b64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface LiveSttEvents {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
}

export class SarvamLiveStt {
  private ws: WebSocket;
  private open = false;
  private pending: Uint8Array[] = [];
  private parts: string[] = [];
  private lang: string | null = null;
  private closed = false;
  private finishing: { resolve: (r: { text: string; languageCode: string | null }) => void; reject: (e: Error) => void } | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private hard: ReturnType<typeof setTimeout> | undefined;
  readonly openedAt = Date.now();
  firstPartialAt = 0;
  bytes = 0;

  constructor(private rate: 16000 | 8000, keyterms: string[], private ev: LiveSttEvents = {}) {
    if (!config.sarvamApiKey) throw new SttError("STT_CONFIG", "SARVAM_API_KEY is not set");
    const q = new URLSearchParams({
      model: "saaras:v4", mode: "codemix", "language-code": "ml-IN",
      sample_rate: String(rate), input_audio_codec: "pcm_s16le", vad_signals: "true", flush_signal: "true",
    });
    const terms = [...new Set((keyterms.length ? keyterms : BASE_KEYTERMS).map((t) => t.trim()).filter((t) => t && t.length <= 64))].slice(0, 50);
    if (terms.length) q.set("keyterms", JSON.stringify(terms));
    // Key as a subprotocol — the edge runtime can't set headers on outgoing sockets.
    this.ws = new WebSocket(`${config.sarvamWsBase}/speech-to-text/ws?${q}`, [`api-subscription-key.${config.sarvamApiKey}`]);
    this.ws.onopen = () => { this.open = true; for (const p of this.pending) this.sendFrame(p); this.pending = []; };
    this.ws.onmessage = (e: MessageEvent) => this.onMessage(e);
    this.ws.onerror = () => this.fail(new SttError("STT_UNAVAILABLE", "stt socket error"));
    this.ws.onclose = () => { if (this.finishing) this.settle(); };
  }

  /** Raw PCM s16le mono frame (any size). */
  push(pcm: Uint8Array) {
    if (this.closed || this.finishing || !pcm.length) return;
    this.bytes += pcm.length;
    if (!this.open) { this.pending.push(pcm); return; }
    this.sendFrame(pcm);
  }
  private sendFrame(pcm: Uint8Array) {
    // ≤ 100 ms per message keeps Sarvam's VAD responsive.
    const frame = this.rate / 10 * 2;
    for (let i = 0; i < pcm.length; i += frame) {
      try { this.ws.send(JSON.stringify({ audio: { data: b64(pcm.subarray(i, i + frame)), sample_rate: String(this.rate), encoding: "audio/wav" } })); } catch { /* closed */ }
    }
  }

  /** End of utterance: flush and resolve with the final transcript. */
  finish(): Promise<{ text: string; languageCode: string | null }> {
    if (this.closed) return Promise.reject(new SttError("STT_UNAVAILABLE", "closed"));
    return new Promise((resolve, reject) => {
      this.finishing = { resolve, reject };
      if (this.bytes < 3200) return this.fail(new SttError("STT_EMPTY", "audio too short"));
      const flush = () => { try { this.ws.send(JSON.stringify({ type: "flush" })); } catch { /* ignore */ } };
      if (this.open) flush(); else this.ws.addEventListener("open", flush, { once: true });
      // Nothing more after the flush → done with what we have. Text that arrived just before
      // the flush settles quickly; a slow socket gets a hard cap.
      this.idle = setTimeout(() => this.settle(), this.parts.length ? 900 : 2500);
      this.hard = setTimeout(() => this.settle(), 6000);
    });
  }

  cancel() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle); clearTimeout(this.hard);
    try { this.ws.close(); } catch { /* ignore */ }
    if (this.finishing) { const f = this.finishing; this.finishing = null; f.reject(new SttError("STT_UNAVAILABLE", "cancelled")); }
  }

  private onMessage(ev: MessageEvent) {
    let m: { type?: string; data?: Record<string, unknown> };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === "events") {
      if (m.data?.signal_type === "START_SPEECH") this.ev.onSpeechStart?.();
      else if (m.data?.signal_type === "END_SPEECH") this.ev.onSpeechEnd?.();
    } else if (m.type === "data") {
      const t = String(m.data?.transcript || "").trim();
      if (t) {
        this.parts.push(t);
        this.lang = (m.data?.language_code as string) || this.lang;
        if (!this.firstPartialAt) this.firstPartialAt = Date.now();
        this.ev.onPartial?.(this.parts.join(" "));
      }
      if (this.finishing) { clearTimeout(this.idle); this.idle = setTimeout(() => this.settle(), 300); }
    } else if (m.type === "error") {
      this.fail(new SttError("STT_UNAVAILABLE", String(m.data?.error || "stt error")));
    }
  }

  private settle() {
    if (!this.finishing) return;
    const f = this.finishing; this.finishing = null;
    this.closed = true; clearTimeout(this.idle); clearTimeout(this.hard);
    try { this.ws.close(); } catch { /* ignore */ }
    const text = this.parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) f.reject(new SttError("STT_EMPTY", "no speech recognised"));
    else f.resolve({ text, languageCode: this.lang });
  }
  private fail(e: Error) {
    if (this.finishing) {
      const f = this.finishing; this.finishing = null;
      this.closed = true; clearTimeout(this.idle); clearTimeout(this.hard);
      try { this.ws.close(); } catch { /* ignore */ }
      f.reject(e);
    } else { this.closed = true; try { this.ws.close(); } catch { /* ignore */ } }
  }
  get failed() { return this.closed && !this.finishing; }
}
