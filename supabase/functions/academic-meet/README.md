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
