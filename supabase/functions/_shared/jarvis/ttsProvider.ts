// Text-to-speech behind one interface. Default: Sarvam Bulbul v3 over the streaming
// WebSocket (wss://api.sarvam.ai/text-to-speech/ws). Audio chunks are forwarded the moment
// they arrive — the caller never waits for the whole file.
import { config } from "./config.ts";

export interface TtsChunk { audioBase64: string; mimeType: string }
export interface TtsProvider {
  readonly name: string;
  stream(text: string, languageCode: "ml-IN" | "en-IN", onChunk: (c: TtsChunk) => void): Promise<void>;
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

  stream(text: string, languageCode: "ml-IN" | "en-IN", onChunk: (c: TtsChunk) => void): Promise<void> {
    const body = speakable(text);
    if (!body) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      // Key as a subprotocol (edge runtime can't send custom WebSocket headers) — see sttProvider.
      const ws = new WebSocket(`${config.sarvamWsBase}/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`, [`api-subscription-key.${config.sarvamApiKey}`]);
      let settled = false, got = 0;
      const timer = setTimeout(() => done(got ? null : new TtsError("TTS_TIMEOUT", "no audio")), 25_000);
      function done(err: Error | null) {
        if (settled) return; settled = true; clearTimeout(timer);
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
