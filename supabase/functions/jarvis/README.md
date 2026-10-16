# Jarvis — realtime voice assistant backend

Read-only voice layer on top of the existing ERP. It does not have its own copy of company data.
Speech (Malayalam / English / Manglish) → live ERP tools → spoken answer.

## Realtime architecture (2026-10-16)

```
browser (jarvis-voice.js)                                   edge function `jarvis` (Deno)
 mic, kept open for the conversation                         realtime.ts — one WebSocket per conversation
  └ AudioWorklet → 16 kHz PCM16, 20 ms frames                 ├ hello → ERP session verified (auth.ts), memory warmed
  └ client VAD (adaptive floor): speech start / end ──WS──▶   ├ speech_start → new turn id, aborts the old turn
  └ frames stream WHILE the user talks ──────────────WS──▶   │   └ sttLive.ts: Sarvam Saaras v4 socket, frames forwarded live
                                                              ├ speech_end → flush → final transcript (~0.3–0.6 s)
                                                              └ voiceEngine.runTurn (cancellable)
                                                                  ├ llmProvider: Claude | Sarvam, TOKEN STREAM + parallel tools
                                                                  ├ erpTools: 24 read-only tools (authorised per call)
                                                                  ├ knowledge.ts: ERP product rules (get_erp_knowledge)
                                                                  └ TtsPipeline: phrase-by-phrase Bulbul v3, in order
  ◀── assistant.delta / status / audio.chunk (tagged by turn) ──┘
 MSE player starts on the first phrase
 barge-in: user voice while Jarvis talks → audio stops, speech_start → server aborts LLM/TTS
```

- **Deploy with `--no-verify-jwt`** — a browser WebSocket can't send the gateway header; the ERP session token is
  verified inside the function (hello message for the socket, `x-erp-session` for POST).
- The POST + SSE path (record → upload) still exists as the fallback when the socket can't open.
- **Latency telemetry**: every turn writes per-stage timings to `jarvis_audit_log.stage_timings`
  (`20261025_jarvis_realtime.sql`); in the browser set `localStorage.jarvis_debug = '1'` for a console table.
- **Knowledge base**: `_shared/jarvis/knowledge.ts` — one entry per ERP workflow. Edit it when a rule changes and
  redeploy; the model fetches entries on demand, nothing is pasted into every prompt.
- Tests: mocked Sarvam (SSE LLM, STT socket), TTS pipeline ordering/abort, realtime barge-in — see the commit message.

## Setup (once)

1. **Run the SQL:** `supabase/migrations/20261012_jarvis.sql` creates the audit and memory tables. They are locked to
   the server by row-level security.
2. **Set the secrets.** They never reach the browser.
   ```bash
   supabase secrets set --project-ref fevqnpllmarhoqdzpatq \
     SARVAM_API_KEY=... ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic CLAUDE_MODEL=claude-opus-5-5 JARVIS_LLM_EFFORT=low \
     JARVIS_MAX_TOOL_CALLS=8 JARVIS_TIMEZONE=Asia/Kolkata \
     JARVIS_ALLOWED_ORIGINS=https://work.brokenenglish.in
   ```
   - Optional settings: `ERP_INTERNAL_API_BASE` and `ERP_INTERNAL_API_TOKEN` (default to this project's URL and
     service role), `JARVIS_TTS_SPEAKER` (default `shubh`), `SARVAM_LLM_MODEL` (default `sarvam-105b`).
3. **Deploy:**
   ```bash
   supabase functions deploy jarvis --no-verify-jwt --project-ref fevqnpllmarhoqdzpatq
   ```
4. **No Jarvis login.** The normal ERP login (index.html) also calls the `erp-session` function, which repeats the
   password + HR access check on the server and returns a signed session token. Jarvis trusts only that token,
   and re-reads identity and access from HR on every question. Deploy both functions:
   `supabase functions deploy jarvis erp-session --project-ref fevqnpllmarhoqdzpatq`
5. **Access:** every active employee can use Jarvis; what they can read follows their ERP access (table below).

## Access

Effective access is resolved the same way as the ERP (`hrAccessRole`: System Role → designation default → team roles; HR admin via roster role `admin` / `hr_admin`; Sales head via a head/manager title):

| Who | Jarvis can read |
|---|---|
| Founder / Co-Founder / Manager / management & system accounts | everything (org) |
| Academic Head, Class Coordinator, Operations Manager | all Academic classes, batches, trainer leave, Academic metrics |
| Fluency Coach / trainer | own classes and own unmarked attendance only |
| HR (division hr, roster admin, hr_admin) | company attendance and leave, trainer leave |
| Student Counselor Head | whole Sales team + CRM |
| Student Counselor | own leads and enrolments only |
| Media Head | Media metrics |
| Everyone | own tasks, own attendance, leave balance and requests |

- Role and permissions are re-read from HR on every request, so role changes, deactivation and exits apply immediately.
- Tools a person may not use are not offered to the model, and each tool checks permissions again on the server.
- Every tool is read-only, with no SQL, no write paths and no contact numbers. Write requests ("approve…", "delete…") get the fixed read-only reply.

## Event stream (SSE, one JSON object per `data:` line)

```
{"type":"state","state":"TRANSCRIBING"}      IDLE LISTENING TRANSCRIBING THINKING CHECKING_ERP CHECKING_CRM SPEAKING ERROR
{"type":"transcript.partial","text":"…"}
{"type":"transcript.final","text":"…"}
{"type":"assistant.text","text":"…","language":"ml-IN"}
{"type":"audio.chunk","audio":"<base64 mp3>","mimeType":"audio/mpeg","seq":0}
{"type":"error","code":"TTS_UNAVAILABLE","message":"…"}   friendly messages only
{"type":"done","stt_ms":…,"llm_ms":…,"tts_ms":…,"total_ms":…,"tts":true}
```

`LISTENING` is emitted by the browser client while the mic is open. The server starts at `TRANSCRIBING`.

## Notes

- **Partial transcripts:** the Saaras v4 streaming endpoint returns a transcript per speech segment, not
  word-by-word. Each segment is forwarded as `transcript.partial`. Only the final utterance goes to the LLM.
  Sarvam's realtime beta endpoint (word-level interim results) can be added behind `SttProvider` later.
- **Leave engine:** attendance summaries run the same `leave-policy.js` engine as the portals. A copy is vendored
  at `_shared/jarvis/vendor/` and kept identical by `.githooks/pre-commit`. Timestamps are converted to India
  wall-clock time because the edge runtime runs in UTC.
- **Cost guard:** 12 turns per user per minute, at most `JARVIS_MAX_TOOL_CALLS` tool calls per answer, and
  questions capped at 60 seconds of audio.

## Wake word: "Hey Jarvis"

`jarvis-wake.js` (`window.JarvisWake`) is the shared wake-word service for every portal.

**What it does:**
- **Detection on the device:** Picovoice Porcupine runs as WebAssembly in the browser. While it waits for the wake phrase, no audio leaves the device.
- **One mic stream:** Picovoice WebVoiceProcessor feeds both the detector and a 0.5 s pre-roll buffer, so "Hey Jarvis, who has classes today?" keeps the start of the question.
- **On detection:** a soft ding (about 220 ms), the `jarvis.wake` event, then state `WAKE_DETECTED` followed by `LISTENING`. The turn runs through the same `JarvisVoice` engine as a globe tap, fed by the same mic stream, with the same STT, ERP tools and TTS.
- **Pausing:** detection pauses for any state other than IDLE (listening, thinking, checking ERP, speaking), so Jarvis can't wake itself and sessions never overlap.
- **Preference:** stored per employee on each device, under `localStorage jarvis_wake_pref:<email>`. A chip under the globe or orb toggles it ("● “Hey Jarvis” on"). The first time someone uses Jarvis it offers "Enable voice activation".
- **Lifecycle:** the mic is released when the tab is hidden and restarted when it's visible again, provided the preference is ON and mic permission isn't denied. The listener is restored after a page reload.
- **Sign-in required:** settings come from `GET /functions/v1/jarvis?config=wake`, which needs a valid ERP session.

**Setup:**
1. Create a Picovoice Console account (console.picovoice.ai) and copy your **AccessKey**. Check the plan terms for company (commercial) use.
2. In the Console, train a **Porcupine** keyword "Hey Jarvis" with platform **Web (WASM)**. Save the downloaded `.ppn` in this repo as `jarvis/hey-jarvis_wasm.ppn`. Until that file exists, the built-in keyword "Jarvis" is used.
3. Set the secrets:
   ```bash
   supabase secrets set --project-ref fevqnpllmarhoqdzpatq PICOVOICE_ACCESS_KEY=... JARVIS_WAKE_SENSITIVITY=0.5
   ```
   Sensitivity runs from 0 to 1. Higher values catch more wake phrases but trigger falsely more often; 0.5 is the default.

**Limits:**
- **Background:** it works while the ERP tab or app is open and active. A suspended browser or PWA, a locked screen, or a backgrounded tab on mobile can't listen; detection resumes when the app is active again.
- **iOS:** Safari may ask for microphone permission again in new sessions.
