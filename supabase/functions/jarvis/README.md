# Jarvis — voice assistant backend (Founder Deck)

Read-only voice layer on top of the existing ERP. It does not have its own copy of company data.
Speech (Malayalam / English / Manglish) → live ERP tools → spoken answer.

```
Founder Deck globe (be-command-center/assets/jarvis-voice.js)
   │  POST raw 16 kHz PCM  +  Supabase Auth bearer token
   ▼
supabase/functions/jarvis/index.ts           — auth, rate limit, SSE stream
   └─ _shared/jarvis/voiceEngine.ts          — turn orchestrator + globe states
        ├─ sttProvider.ts   Sarvam Saaras v4 streaming WebSocket (codemix, ml-IN, keyterms, VAD)
        ├─ llmProvider.ts   Claude (default) | Sarvam 105B — tool-use loop behind one interface
        ├─ erpTools.ts      9 read-only tools, Zod-validated, per-role access, executeErpTool()
        ├─ erpServices.ts   fixed reads of the real ERP tables (same rules as the portals)
        ├─ ttsProvider.ts   Sarvam Bulbul v3 streaming WebSocket (ml-IN / en-IN)
        ├─ jarvisAudit.ts   jarvis_audit_log + short session memory (jarvis_turns)
        ├─ auth.ts          token → verified email → hr_employees → access scope
        └─ time.ts          Asia/Kolkata date resolution
```

Spec file names map to these files: `src/services/<name>.ts` is `supabase/functions/_shared/jarvis/<name>.ts`, and
`src/app/api/voice-assistant/route.ts` is `supabase/functions/jarvis/index.ts`. The ERP runs on GitHub Pages and
Supabase, with no Next.js server. Supabase Edge Functions run the voice turn, so a separate
WebSocket server is not needed. The server holds the Sarvam sockets and streams back to the browser over SSE.

## Setup (once)

1. **Run the SQL:** `supabase/migrations/20261012_jarvis.sql` creates the audit and memory tables. They are locked to
   the server by row-level security.
2. **Set the secrets.** They never reach the browser.
   ```bash
   supabase secrets set --project-ref fevqnpllmarhoqdzpatq \
     SARVAM_API_KEY=... ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic CLAUDE_MODEL=claude-sonnet-4-6 \
     JARVIS_MAX_TOOL_CALLS=6 JARVIS_TIMEZONE=Asia/Kolkata \
     JARVIS_ALLOWED_ORIGINS=https://amailtosreekanth-cpu.github.io
   ```
   - Optional settings: `ERP_INTERNAL_API_BASE` and `ERP_INTERNAL_API_TOKEN` (default to this project's URL and
     service role), `JARVIS_TTS_SPEAKER` (default `shubh`), `SARVAM_LLM_MODEL` (default `sarvam-105b`).
3. **Deploy:**
   ```bash
   supabase functions deploy jarvis --project-ref fevqnpllmarhoqdzpatq
   ```
4. **Set up Supabase Auth email sign-in** (Dashboard → Authentication):
   - **Email provider:** enabled.
   - **URL Configuration → Redirect URLs:** add the Founder Deck URL (for the magic link).
   - **Email Templates → Magic Link:** include `{{ .Token }}` so the email carries the 6-digit code, and keep
     `{{ .ConfirmationURL }}` for the link.
   - **SMTP:** the built-in sender is rate-limited. Set up custom SMTP (e.g. Brevo, which payslips already use)
     before wider use.
5. **Grant access in HR:** Jarvis works only for people whose HR record (matched by portal email) has a
   leadership System Role (manager, founder, co_founder, …), Academic Head access, or trainer access.

## Access

| Resolved from HR | Jarvis scope | Tools |
|---|---|---|
| system_role manager / founder / co_founder / managing_director / director, account_type management | `org` | all 9 |
| Academic Head, Class Coordinator, Operations Manager | `academic` | classes, unmarked attendance, upcoming batches, trainer leave, academic metrics |
| Trainer / Fluency Coach | `trainer` | own classes and own unmarked attendance only (trainer filter forced on the server) |

- The role is never read from the browser.
- Every tool is read-only, with no SQL, no write paths and no contact numbers.
- Write requests ("approve…", "delete…") get the fixed read-only reply.

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
