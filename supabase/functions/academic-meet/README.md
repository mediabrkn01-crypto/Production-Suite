# academic-meet — Academic → Live Classes (Google Calendar + Google Meet)

ERP class → Google Calendar event (+ Meet conference) → trainer/student invitations → Meet URL
saved in the ERP. The ERP stays the source of truth; Google is the meeting + invitation layer.

## Pieces

| Piece | What it does |
|---|---|
| `academic-meet.html` / `.js` / `.css` (site root) | The Live Classes tab. Loaded **into** `academics.html` (`acadLoadLiveClasses`) — never a page navigation |
| `supabase/functions/academic-meet` | This function: `academicMeetService.ts` (create / update / cancel / resend / details) |
| `supabase/functions/_shared/google/` | `googleAuthService`, `googleCalendarService`, `googleMeetService` |
| `supabase/migrations/20261016_academic_live_classes.sql` + `20261017_live_class_report.sql` | `academic_live_classes` (link per class occurrence), `academic_meet_batches` (online batches), `academic_meet_config` (organizer token, no browser access) |

A class is identified by its ERP occurrence: `class:<batch_id>:<original_date>` for batch classes,
`oto:<oto_sessions.id>` for group 1:1 sessions. A postponed class keeps its key, so its **same**
Calendar event is updated. The Calendar event id is derived from that key, so a repeated create can
never make a second event or a second Meet link.

## One-time setup

1. **Run the SQL**: `supabase/migrations/20261016_academic_live_classes.sql` in the Supabase SQL editor.
2. **Google Cloud project** (one project):
   - APIs & Services → enable **Google Calendar API** and **Google Meet API**.
   - OAuth consent screen: *Internal* if Broken English uses Google Workspace, otherwise *External*
     and add the organizer account as a test user (or publish the app).
     Scopes: `calendar.events`, `calendar.readonly`, `meetings.space.readonly`.
   - Credentials → **OAuth client ID** → *Web application*. Authorised redirect URI:
     `https://fevqnpllmarhoqdzpatq.supabase.co/functions/v1/academic-meet?action=oauth_callback`
3. **Secrets** (Supabase → Edge Functions → Secrets):
   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```
   Optional: `GOOGLE_CALENDAR_ID` (default `primary`), `GOOGLE_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`.
4. **Deploy** (no Supabase JWT check — Google's redirect has none; every API call is authorised by
   the ERP session token):
   ```
   supabase functions deploy academic-meet --no-verify-jwt --use-api
   ```
5. **Connect the organizer**: an Academic Head opens Academic → Live Classes → *Connect Google
   account* and signs in as the organisation account (e.g. `academics@…`). The refresh token is
   stored server-side in `academic_meet_config` and never reaches the browser.

## Access (resolved from HR on every request)

| Who | Can |
|---|---|
| Academic Head, Class Coordinator, Operations Manager | view all, create Meet, edit time, cancel, send / resend invitations |
| Manager, Founder, Co-Founder | view all Live Classes |
| Fluency Coach / trainer | own classes: view, join, copy link (a time change they make through Postpone is synced to Google) |

## Notes

- Invitations, time changes and cancellations are emailed by Google Calendar (`sendUpdates=all`).
- Missing/invalid emails never block a Meet: the class is created and the modal lists who was not
  invited; fix the student email there and use *Resend Invitation*. Trainer email comes from the
  HR employee record (`portal_email`, then `personal_email`).
- Group events hide the guest list from students (`guestsCanSeeOtherGuests=false`).
- Event reminders (default 30 min) apply to the organizer's calendar; each attendee's Google
  Calendar also applies its own notification settings.
- Cancel in Live Classes marks that one class cancelled (`academic_live_classes.class_status`) and
  cancels the Calendar event. It does not change the batch schedule or attendance.
- Future attendance: `google_conference_record` / `meet_participants` / `attendance_suggestion`
  columns and `googleMeetService.listConferenceRecords/listParticipants` are in place. Version 1
  never writes attendance from Meet.
- Later, Google Workspace domain-wide delegation can replace the single organizer token inside
  `googleAuthService.getAccessToken()` without touching anything else.

## Live class workflow (part 2)

- **Review email**: every class event also invites the review address (Live Classes → Settings,
  default `reviewbrk@gmail.com`; the `ACADEMIC_MEET_REVIEW_EMAIL` secret overrides it). Emails are
  normalised and de-duplicated before they're sent to Google.
- **Copy Details / Share**: a WhatsApp-ready class message (class, course, day + date, time,
  trainer, type, students, Meet link). Share uses the Web Share API, otherwise copies.
- **Join Live** opens Meet in a new tab and records the join in the ERP (class shows *Live*).
- **End Class** marks the class ended in the ERP and starts the Meet report sync. These two clicks
  are ERP activity only — the official times come from Google Meet conference records.
- **Meet report**: conference records → participants → sessions give actual start/end/duration,
  trainer join/leave/presence and each participant's minutes. Meet shares display names, not
  emails, so people are matched to the roster by name. If Google hasn't published the report yet
  the class shows *Waiting* and re-checks when the popup is opened (every 2 min at most).
- **Attendance**: suggestions only (Present ≥ half the scheduled class, Review < half, Absent =
  didn't join). *Confirm in Class & Attendance* opens the existing attendance screen pre-filled;
  saving there is the only way attendance is recorded. The class then shows *Attendance confirmed*.
- **History**: `academic_live_class_events` (Meet created, invitation sent, review email invited,
  joined live, meeting started/ended, trainer joined, report synced, attendance confirmed…).

## Google limits, sync queue and verification (20261021)

- **Errors are classified** (`syncGuard.ts`): `quotaExceeded` / "Calendar usage limits exceeded"
  → organizer-wide pause (15 min, doubling, ≤ 12 h, ±20 % jitter; cleared by the next successful
  write); `rateLimitExceeded` / `userRateLimitExceeded` / HTTP 429 → per-class backoff
  (30 s doubling, ≤ 30 min); 5xx / network → backoff (1 min doubling, ≤ 1 h); auth errors and
  other 4xx → Sync Failed (no automatic retry). HTTP status + `error.reason` are stored on the
  class (`last_error_status`, `last_error_reason`) and shown in the admin diagnostics.
- **Nothing is lost while Google limits the account**: the class stays `pending` with
  `next_retry_at` ("Waiting for Google"); no Calendar call is made until the pause ends.
- **Queue** (`enqueue` / `process_queue` actions): bulk create, online batches and trainer
  changes are queued server-side and processed one class at a time, 2.5 s apart (concurrency 1
  via `academic_meet_config.queue_lock_until`), continuing in the background after the response
  (`EdgeRuntime.waitUntil`). An open Live Classes page (Academic team) nudges it every 3 min.
  There is no server cron yet — with nobody on the page, queued classes wait for the next visit.
- **Idempotent**: one deterministic event id per class (repeat insert → 409 → adopt), the Meet
  room made before the Calendar insert is saved and reused on retry.
- **Writes only when needed**: update/retry/verify read the event first; `sendUpdates=all`
  only when the time or guest list changed or on Resend; unchanged → no write, no emails.
- **Synced = verified**: the returned event must contain the trainer (and the review address
  when configured). Per-component status: `calendar_event_status`, `meet_status`,
  `trainer_invite_status`, `review_invite_status`, `trainer_calendar_invited`, `cohost_status`.
- **Co-host**: Google only lets a Google Workspace organizer add Meet co-hosts; with a personal
  Gmail organizer the Meet API answers 403 and the trainer joins as a guest (`unsupported`).
- **Verify + repair**: the queue re-reads upcoming Synced classes (once, then when something is
  missing) and patches the SAME event if the trainer/review attendee is missing.

## Trainer owns the Meet (20261022)

The assigned trainer's OWN Google account creates the Calendar event + Meet room, so the trainer
is the real organizer: enters directly and gets Admit / Deny for students who ask to join.

- **Connect once** — Academic → Live Classes → "Google Meet account" → Connect Google account
  (standard Google consent, `prompt=consent select_account`). Scopes: `openid`,
  `userinfo.email`, `calendar.events`, `meetings.space.created`, `meetings.space.readonly`.
  The callback (same redirect URI, state `oauth-trainer:<erp email>`) stores in
  `employee_google_connections` (RLS on, no policies → server only): Google email + user id,
  AES-256-GCM encrypted refresh token, scopes, timestamps, status. No password, nothing in the
  browser. Disconnect revokes the token at Google and deletes the row.
- **Every class action runs as the class owner** (`runAs()` in googleAuthService): the trainer's
  account for trainer-owned classes, the central account (Classes BRK) for fallback classes.
  Limits / backoff are per Google account.
- **Create**: trainer connected → event in the trainer's `primary` calendar, Meet room created by
  the trainer with TRUSTED access (invited guests join directly; others ask to join and the
  trainer admits). Trainer is the organizer, not an attendee. Ownership is verified from
  Google's own answer (`event.organizer.email` = the connected account).
  Trainer not connected → no Meet, "Trainer Google Meet account not connected" (no silent
  fallback). "Create with Classes BRK (fallback)" is an explicit Academic action and is marked
  "Fallback organizer".
- **Existing Classes BRK classes**: "Recreate using trainer account" (admin, before the class
  starts) creates the new event + room as the trainer first, then cancels the old event.
  A trainer-owned class reassigned to another trainer is moved the same way.
- **Join Live** for the host trainer opens Meet with `authuser=<connected email>`.

Setup (one time):
1. Secret `GOOGLE_TOKEN_ENC_KEY` = base64 of 32 random bytes
   (`openssl rand -base64 32`). Never change it once trainers have connected (they'd have to
   reconnect).
2. Google Cloud console → OAuth consent screen: add the scopes above. While the app is in
   "Testing", only listed test users (max 100) can connect — add each trainer's Google email,
   or publish the app (calendar.events is a sensitive scope → Google verification).
3. Migration `20261022_trainer_google_organizer.sql`.
