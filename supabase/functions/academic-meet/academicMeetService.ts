// academicMeetService — ERP class occurrence ⇄ Google Calendar event + Meet link.
//
// The ERP is the source of truth. Every call re-reads the class from the ERP tables (batches /
// class_postponements / oto_sessions / students / trainers / hr_employees) — the browser only
// says WHICH class (occurrence_key). Times, trainer and attendees are never taken from the
// browser except the start time of a regular, un-postponed occurrence whose batch time_slot
// can't be parsed.
//
//   createClassMeeting()   ERP class → Calendar event (+ Meet conference) → invitations
//   updateClassMeeting()   time change (Postpone = same date, new time) → SAME event updated
//   cancelClassMeeting()   ERP class cancelled → Calendar event cancelled (attendees notified)
//   resendInvitations()    attendee list rebuilt from the ERP (e.g. after an email was fixed)
//   getMeetingDetails()    link row + attendees, refreshed against Google
//
// Duplicate protection: (1) one link row per occurrence_key (unique); (2) a short "syncing"
// claim on that row so parallel clicks can't both call Google; (3) a deterministic Calendar
// event id derived from the occurrence key, so even a retried insert can only ever hit the
// same event (Google answers 409) — never a second event / second Meet link.
import { adminClient, can, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { GoogleApiError, loadOrganizer, googleConfig, runAs, currentActor } from "../_shared/google/googleAuthService.ts";
import { ORG, actorForEmployee, actorForRow, actorForTrainer, employeeOfTrainer } from "./owners.ts";
import * as Cal from "../_shared/google/googleCalendarService.ts";
import { loadLeaveIndex } from "../_shared/trainer-availability.ts";
import { sessionLabel, sessionNumberForClass } from "../_shared/session-number.ts";
import { addMember, conferenceFor, createSpace, getSpaceByMeetingCode, listConferenceRecords, listMembers, listParticipants, listParticipantSessions, removeMember } from "../_shared/google/googleMeetService.ts";
import { classify, calendarPause, pauseCalendar, clearPause, takeQueueLock, releaseQueueLock, RETRY, LIMIT_MSG, RATE_MSG, sleep } from "./syncGuard.ts";

export class MeetError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const TZ = "Asia/Kolkata";
const T = "academic_live_classes";
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const toMin = (t: unknown) => { const m = String(t ?? "").match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
/** "9:30 PM – 10:30 PM" / legacy "8.30 PM" → minutes (same rule as academics.html _parseTimeLabelToMinutes). */
const labelMin = (label: unknown) => {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(String(label ?? "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12; if (/p/i.test(m[3])) h += 12;
  return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
};
const fmt12 = (min: number) => { const h = Math.floor(min / 60) % 24; return `${(h + 11) % 12 + 1}:${pad(min % 60)} ${h < 12 ? "AM" : "PM"}`; };
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s ?? "").trim());
const addDay = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const canManage = (a: JarvisAuthContext) => a.role === "academic_head" && can(a, "academic.all");
const canView = (a: JarvisAuthContext, trainerId: string | null) =>
  can(a, "academic.all") || (can(a, "academic.own") && !!a.trainerId && a.trainerId === trainerId);

interface Person { role: "trainer" | "student" | "review"; id: string; name: string; email: string | null }
export interface ClassInfo {
  key: string; kind: "class" | "oto";
  batchId: string | null; otoId: string | null; originalDate: string;
  date: string; startMin: number; endMin: number;
  trainerId: string | null; trainer: Person | null; students: Person[];
  batchName: string; course: string; typeLabel: string; isOne: boolean; title: string; description: string;
  sessionNo: number | null;
  reviewEmail: string | null;
}

export function parseKey(key: string): { kind: "class"; batchId: string; date: string } | { kind: "oto"; otoId: string } {
  let m = new RegExp(`^class:(${UUID}):(\\d{4}-\\d{2}-\\d{2})$`, "i").exec(key || "");
  if (m) return { kind: "class", batchId: m[1], date: m[2] };
  m = new RegExp(`^oto:(${UUID})$`, "i").exec(key || "");
  if (m) return { kind: "oto", otoId: m[1] };
  throw new MeetError(400, "BAD_KEY", "Unknown class.");
}

export async function resolveClass(key: string, hint: { start?: string } = {}): Promise<ClassInfo> {
  const sb = adminClient(), k = parseKey(key);
  const BCOLS = "id,name,programme,trainer_id,trainer_name,capacity,class_duration_minutes,time_slot,status,deleted_at,day_pattern,course_id,start_date,expected_completion_date,group_classes_completed_at";
  let batch: any, date: string, startMin: number | null, endMin: number | null, trainerId: string | null, originalDate: string;
  let students: Person[] = [], sessionNo: number | null = null;

  if (k.kind === "oto") {
    const { data: o } = await sb.from("oto_sessions").select("id,batch_id,student_id,trainer_id,session_number,session_date,start_time,end_time,duration_minutes,status").eq("id", k.otoId).maybeSingle();
    if (!o) throw new MeetError(404, "NOT_FOUND", "This 1:1 session no longer exists.");
    ({ data: batch } = await sb.from("batches").select(BCOLS).eq("id", o.batch_id).maybeSingle());
    date = String(o.session_date).slice(0, 10); originalDate = date;
    startMin = toMin(o.start_time); endMin = toMin(o.end_time);
    if (startMin == null) throw new MeetError(409, "NO_TIME", "This 1:1 session has no time set yet.");
    if (endMin == null || endMin <= startMin) endMin = startMin + (Number(o.duration_minutes) || 30);
    trainerId = o.trainer_id || batch?.trainer_id || null;
    sessionNo = Number(o.session_number) || null;
    if (o.student_id) {
      const { data: s } = await sb.from("students").select("id,name,email").eq("id", o.student_id).maybeSingle();
      if (s) students = [{ role: "student", id: s.id, name: s.name || "Student", email: isEmail(s.email) ? String(s.email).trim().toLowerCase() : null }];
    }
  } else {
    ({ data: batch } = await sb.from("batches").select(BCOLS).eq("id", k.batchId).maybeSingle());
    if (!batch || batch.deleted_at) throw new MeetError(404, "NOT_FOUND", "This batch no longer exists.");
    if (String(batch.status || "").toLowerCase() !== "active") throw new MeetError(409, "NOT_ACTIVE", "This batch is not active.");
    originalDate = k.date;
    const { data: pp } = await sb.from("class_postponements").select("new_date,new_start,status").eq("kind", "class").eq("batch_id", batch.id)
      .eq("original_date", k.date).eq("status", "active").order("postponed_at", { ascending: false }).limit(1);
    const dur = Number(batch.class_duration_minutes) || 60;
    if (pp && pp[0]) { date = String(pp[0].new_date).slice(0, 10); startMin = toMin(pp[0].new_start); }
    else { date = k.date; startMin = labelMin(batch.time_slot) ?? toMin(hint.start); }
    if (startMin == null) throw new MeetError(409, "NO_TIME", "This batch has no class time set.");
    endMin = startMin + dur;
    trainerId = batch.trainer_id || null;
    // Which session of this batch (shared rule — session-number.js / _shared/session-number.ts).
    sessionNo = await sessionNumberForClass(sb, batch, date, labelMin(batch.time_slot) ?? startMin, dur).catch(() => null);
    const { data: ss } = await sb.from("students").select("id,name,email,status").eq("batch_id", batch.id);
    students = (ss || []).filter((s: any) => String(s.status || "").toLowerCase() !== "dropped")
      .map((s: any) => ({ role: "student" as const, id: s.id, name: s.name || "Student", email: isEmail(s.email) ? String(s.email).trim().toLowerCase() : null }));
  }

  // Trainer email — the central HR employee record (portal login email, then personal email).
  let trainer: Person | null = null;
  if (trainerId) {
    const { data: t } = await sb.from("trainers").select("id,name,hr_employee_id,portal_email").eq("id", trainerId).maybeSingle();
    let hr: any = null;
    if (t?.hr_employee_id) ({ data: hr } = await sb.from("hr_employees").select("full_name,portal_email,personal_email").eq("id", t.hr_employee_id).maybeSingle());
    const email = [hr?.portal_email, hr?.personal_email, t?.portal_email].find(isEmail);
    // Always re-read (never a cached copy on the link row) and normalised.
    trainer = { role: "trainer", id: trainerId, name: hr?.full_name || t?.name || batch?.trainer_name || "Trainer", email: email ? String(email).trim().toLowerCase() : null };
  }

  const isOne = k.kind === "oto" || Number(batch?.capacity) === 1;
  const batchName = batch?.name || "1:1 session";
  const course = String(batch?.programme || batchName).trim();
  const who = isOne ? (students[0]?.name || batchName) : batchName;
  const typeLabel = k.kind === "oto" ? "Group 1:1" : isOne ? "1:1" : "Group";
  const title = isOne && students[0] ? `Broken English | ${course} – ${who}` : `Broken English | ${batchName}`;
  const description = [
    "Broken English Online Class", ...(sessionNo ? [`Session No.: ${sessionLabel(sessionNo)}`] : []), "",
    `Course:\n${course}`, "",
    `Trainer:\n${trainer?.name || "To be assigned"}`, "",
    `${isOne ? "Student" : "Batch"}:\n${who}${!isOne && students.length ? ` (${students.length} students)` : ""}`, "",
    `Class Type:\n${typeLabel}`, "",
    `Time:\n${fmt12(startMin!)} – ${fmt12(endMin!)} (India time)`, "",
    "Managed through Broken English ERP.",
  ].join("\n");

  const org = await loadOrganizer();
  return { key, kind: k.kind, batchId: batch?.id || null, otoId: k.kind === "oto" ? k.otoId : null, originalDate, date, startMin: startMin!, endMin: endMin!,
    trainerId, trainer, students, batchName, course, typeLabel, isOne, title, description, sessionNo, reviewEmail: isEmail(org.reviewEmail) ? String(org.reviewEmail).trim().toLowerCase() : null };
}

const trainerOwns = () => currentActor().kind === "trainer";
function attendeesOf(info: ClassInfo) {
  const attendees: { email: string; displayName: string }[] = [], invited: any[] = [], notInvited: any[] = [], seen = new Set<string>();
  // Trainer-owned meeting: the trainer is the organizer (their own calendar), not a guest.
  if (trainerOwns()) {
    const own = currentActor().email;
    if (own) { seen.add(own); invited.push({ role: "trainer", id: info.trainer?.id || "trainer", name: info.trainer?.name || "Trainer", email: own, organizer: true }); }
  }
  for (const p of [...(trainerOwns() ? [] : [info.trainer]), ...info.students].filter(Boolean) as Person[]) {
    if (p.email && !seen.has(p.email.toLowerCase())) {
      seen.add(p.email.toLowerCase());
      attendees.push({ email: p.email, displayName: p.name });
      invited.push({ role: p.role, id: p.id, name: p.name, email: p.email });
    } else if (!p.email) notInvited.push({ role: p.role, id: p.id, name: p.name, reason: "missing" });
  }
  // Academic review / monitoring address — invited to every class, never twice.
  if (info.reviewEmail && !seen.has(info.reviewEmail.toLowerCase())) {
    seen.add(info.reviewEmail.toLowerCase());
    attendees.push({ email: info.reviewEmail, displayName: "Broken English Review" });
    invited.push({ role: "review", id: "review", name: "Review / Academic Monitoring", email: info.reviewEmail });
  }
  return { attendees, invited, notInvited };
}

function eventTimes(info: ClassInfo) {
  const end = info.endMin >= 1440 ? { d: addDay(info.date, 1), m: info.endMin - 1440 } : { d: info.date, m: info.endMin };
  return {
    start: { dateTime: `${info.date}T${hm(info.startMin)}:00`, timeZone: TZ },
    end: { dateTime: `${end.d}T${hm(end.m)}:00`, timeZone: TZ },
  };
}

function eventBody(info: ClassInfo, reminders: number[]) {
  const { attendees } = attendeesOf(info);
  const mins = [...new Set(reminders.filter((m) => Number.isInteger(m) && m >= 0 && m <= 1440))].slice(0, 2);
  return {
    summary: info.title, description: info.description, ...eventTimes(info), attendees,
    reminders: { useDefault: false, overrides: mins.flatMap((m) => [{ method: "popup", minutes: m }, { method: "email", minutes: m }]) },
    // Group classes: students never see each other's email addresses.
    guestsCanSeeOtherGuests: info.isOne, guestsCanInviteOthers: false, guestsCanModify: false,
    extendedProperties: { private: { be_occurrence_key: info.key, be_source: "broken-english-erp" } },
  };
}

/** Deterministic Calendar event id (base32hex: 0-9 a-v) — the same class can only ever map to one event. */
/** Deterministic per class AND per owning account: a trainer's calendar already holds an
 *  attendee copy of the Classes BRK event under that event's id, so the trainer-owned event must
 *  use a different id (otherwise Google answers "already exists" with the Classes BRK copy). */
async function eventIdFor(key: string) {
  const act = currentActor();
  const seed = "be-live-class|" + key + (act.kind === "trainer" ? "|emp:" + act.employeeId : "");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  return "be" + [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

const rowFields = (info: ClassInfo) => ({
  occurrence_key: info.key, class_kind: info.kind, batch_id: info.batchId, oto_session_id: info.otoId, trainer_id: info.trainerId,
  original_date: info.originalDate, class_date: info.date, start_time: hm(info.startMin) + ":00",
  end_time: info.endMin >= 1440 ? "23:59:59" : hm(info.endMin) + ":00", summary: info.title,
  scheduled_start: istTs(info.date, info.startMin), scheduled_end: istTs(info.date, info.endMin),
});
/** Wall-clock IST date + minutes → ISO timestamp (minutes may run past midnight). */
function istTs(date: string, min: number) {
  const d = new Date(`${date}T00:00:00+05:30`);
  return new Date(d.getTime() + min * 60000).toISOString();
}

/** Class history (timestamps). `at` lets Meet-derived events carry Google's own time. */
async function logEvent(key: string, event: string, detail: string | null, actor: string | null, at?: string) {
  await adminClient().from("academic_live_class_events")
    .upsert({ occurrence_key: key, event, detail, actor, at: at || new Date().toISOString() }, { onConflict: "occurrence_key,event,at", ignoreDuplicates: true })
    .then(() => {}, () => {});
}
/** Remembered per organizer: can it grant co-host? (null = not tried yet). */
async function cohostSupported(): Promise<boolean> {
  const { data } = await adminClient().from("academic_meet_config").select("cohost_supported").eq("id", 1).maybeSingle().then((r) => r, () => ({ data: null }));
  return data?.cohost_supported === true;
}
function rememberCohost(ok: boolean) {
  return adminClient().from("academic_meet_config").update({ cohost_supported: ok }).eq("id", 1).then(() => {}, () => {});
}

/** Room access stored separately (tolerates the column not existing yet). */
function setAccess(key: string, row: any, access: "open" | "trusted") {
  return adminClient().from(T).update({ google_meet_access: access }).eq("occurrence_key", key).select().maybeSingle()
    .then((r) => (r.error ? row : r.data || row), () => row);
}

/** Replace an invite-only Calendar-made Meet with an OPEN room (new link; Google emails the update). */
export async function openRoom(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only the Academic team can change the Meet room.");
  const info = await resolveClass(key, hint);
  const row = await getRow(key);
  if (!row?.google_calendar_event_id || row.class_status === "cancelled") throw new MeetError(409, "NO_MEET", "This class has no active Meet.");
  if (row.google_organizer_kind === "trainer") throw new MeetError(409, "TRAINER_HOSTED", "The trainer hosts this Meet and admits students — an open link isn't needed.");
  const org = await requireOrganizer();
  await claim(info, a.email);
  try {
    const space = await createSpace("OPEN");
    const cal = row.google_calendar_id || org.calendarId;
    let ev = await Cal.patchEvent(cal, row.google_calendar_event_id, { conferenceData: conferenceFor(space) }, true);
    ev = await settle(cal, ev);
    const reminders = row.reminder_minutes?.length ? row.reminder_minutes : org.defaultReminders;
    const saved = await save(key, { ...(await linkFields({ ...org, calendarId: cal }, ev, info, reminders)), updated_by: a.email });
    await logEvent(key, "Switched to open Meet room", saved?.google_meet_url || null, a.email);
    const withAccess = await setAccess(key, saved, "open");
    return { row: await assignCohost(info, withAccess, a.email) };
  } catch (e) {
    await fail(key, e, a.email);
    throw e;
  }
}

// ── Trainer = Google Meet COHOST (organizer account stays the owner) ─────────────────────
// Adds the class trainer as a COHOST member of the Meet space and removes any other co-host
// (e.g. the previous trainer). Never fails the Meet itself: the outcome is stored on the row
// (cohost_status) and shown in the class popup. The review email is never made co-host.
async function assignCohost(info: ClassInfo, row: any, actor: string) {
  if (trainerOwns()) return ownerHost(info, row);
  const key = info.key, email = info.trainer?.email?.toLowerCase() || null;
  const set = (patch: Record<string, unknown>) =>
    adminClient().from(T).update({ ...patch, updated_at: new Date().toISOString() }).eq("occurrence_key", key).select().maybeSingle()
      .then((r) => (r.error ? row : r.data || row), () => row);
  const space = row?.google_meet_space_name;
  if (!email) return set({ trainer_email: null, trainer_meet_role: null, cohost_status: "missing_email", cohost_error: null });
  if (!space) return set({ trainer_email: email, trainer_meet_role: null, cohost_status: "failed", cohost_error: "The Meet space could not be resolved yet — use Retry Sync." });
  try {
    const members = await listMembers(space);
    const lc = (m: any) => String(m.email || "").toLowerCase();
    for (const m of members) {
      if (m.role === "COHOST" && lc(m) && lc(m) !== email) {
        await removeMember(m.name);
        await logEvent(key, "Co-host removed", m.email, actor);
      }
    }
    const mine = members.find((m: any) => lc(m) === email);
    if (!mine || mine.role !== "COHOST") {
      if (mine) await removeMember(mine.name);
      await addMember(space, email, "COHOST");
      await logEvent(key, "Trainer set as co-host", `${info.trainer!.name} · ${email}`, actor);
    }
    await rememberCohost(true);
    return set({ trainer_email: email, trainer_meet_role: "COHOST", cohost_status: "assigned", cohost_error: null });
  } catch (e) {
    // Google only lets a Google Workspace organizer add co-hosts; a personal Gmail organizer gets 403.
    // Not an error for the class: the trainer joins as a guest. Switches on by itself with Workspace.
    if (e instanceof GoogleApiError && e.status === 403) {
      await rememberCohost(false);
      const r = await set({ trainer_email: email, trainer_meet_role: "GUEST", cohost_status: "unsupported", cohost_error: null });
      if (r?.cohost_status === "unsupported") return r;
      return set({ trainer_email: email, trainer_meet_role: null, cohost_status: "failed", cohost_error: "Co-host needs a Google Workspace organizer account — the trainer joins as a guest." });
    }
    const g = classify(e);
    return set({ trainer_email: email, trainer_meet_role: null, cohost_status: "failed", cohost_error: explain(e).slice(0, 500),
      ...(row?.google_sync_status === "synced" ? { google_sync_status: "pending", google_sync_error: "Trainer co-host could not be set yet. The system will retry automatically.",
        next_retry_at: new Date(Date.now() + (g.kind === "rate_limit" ? RETRY.rate(1) : RETRY.transient(1))).toISOString() } : {}) });
  }
}

function inviteEvents(key: string, row: any, actor: string, resent: boolean) {
  const inv = (row?.invited || []) as any[];
  const people = inv.filter((p) => p.role !== "review");
  const jobs = [logEvent(key, resent ? "Invitation re-sent" : "Invitation sent", people.length ? people.map((p) => p.name).join(", ") : "No participant email on file", actor)];
  if (inv.some((p) => p.role === "review")) jobs.push(logEvent(key, "Review email invited", inv.find((p) => p.role === "review").email, actor));
  return Promise.all(jobs);
}

async function getRow(key: string) {
  const { data } = await adminClient().from(T).select("*").eq("occurrence_key", key).maybeSingle();
  return data as any;
}

/** Take the per-class "syncing" claim. Fails when another request is already talking to Google for it. */
async function claim(info: ClassInfo, by: string) {
  const sb = adminClient(), now = new Date().toISOString(), stale = new Date(Date.now() - 90_000).toISOString();
  await sb.from(T).upsert({ ...rowFields(info), google_sync_status: "pending", created_by: by }, { onConflict: "occurrence_key", ignoreDuplicates: true });
  const { data } = await sb.from(T).update({ google_sync_status: "syncing", google_sync_error: null, updated_at: now, updated_by: by })
    .eq("occurrence_key", info.key).or(`google_sync_status.neq.syncing,updated_at.lt.${stale}`).select().maybeSingle();
  if (!data) throw new MeetError(409, "BUSY", "This class is already syncing with Google — one moment.");
  return data;
}

// Columns added by 20261021_live_class_sync_queue.sql — dropped from a write if that migration
// hasn't been run yet, so the existing flow keeps working.
const SYNC_COLS = ["calendar_event_status", "meet_status", "trainer_invite_status", "review_invite_status", "trainer_calendar_invited",
  "sync_attempts", "next_retry_at", "last_sync_attempt_at", "last_error_status", "last_error_reason", "last_verified_at", "superseded_event"];
async function save(key: string, patch: Record<string, unknown>) {
  const run = (p: Record<string, unknown>) => adminClient().from(T).update({ ...p, updated_at: new Date().toISOString() }).eq("occurrence_key", key).select().maybeSingle();
  let { data, error } = await run(patch);
  if (error && /column|schema cache/i.test(error.message || "")) {
    const p = { ...patch }; SYNC_COLS.forEach((c) => delete p[c]);
    ({ data, error } = await run(p));
  }
  if (error) throw new MeetError(500, "DB", "The Meet link was created in Google but could not be saved in the ERP: " + error.message);
  return data;
}

function explain(e: unknown): string {
  if (e instanceof MeetError || e instanceof GoogleApiError) return e.message;
  return (e as Error)?.message || String(e);
}

/** Google error during a sync: limits / busy / unreachable → queued with backoff (never lost,
 *  never hammered); other errors → Sync Failed. Always records Google's HTTP status + reason. */
async function handleSyncError(key: string, e: unknown, by: string): Promise<never> {
  const g = classify(e);
  const row = await getRow(key).catch(() => null);
  const n = (row?.sync_attempts || 0) + 1, now = new Date();
  let status = "failed", msg = explain(e), next: string | null = null;
  if (g.kind === "calendar_limit") { next = await pauseCalendar(g); status = "pending"; msg = LIMIT_MSG; }
  else if (g.kind === "rate_limit") { next = new Date(now.getTime() + RETRY.rate(n)).toISOString(); status = "pending"; msg = RATE_MSG; }
  else if (g.kind === "transient" || (e instanceof MeetError && e.code === "NO_MEET")) { next = new Date(now.getTime() + RETRY.transient(n)).toISOString(); status = "pending"; msg = "Google could not finish this sync yet. The system will retry automatically."; }
  await save(key, {
    google_sync_status: status, google_sync_error: msg.slice(0, 500), updated_by: by,
    sync_attempts: n, next_retry_at: next, last_sync_attempt_at: now.toISOString(),
    last_error_status: g.status, last_error_reason: g.reason || g.kind,
    ...(row?.google_calendar_event_id ? {} : { calendar_event_status: "failed" }),
  }).catch(() => {});
  if (status === "pending") throw Object.assign(new MeetError(429, "GOOGLE_LIMITED", msg), { nextRetryAt: next, googleStatus: g.status, googleReason: g.reason });
  throw e;
}

/** Calendar writes are paused for the organizer → keep the class queued (nothing is lost). */
async function queueForLater(info: ClassInfo, until: string, by: string) {
  await adminClient().from(T).upsert({ ...rowFields(info), google_sync_status: "pending", created_by: by }, { onConflict: "occurrence_key", ignoreDuplicates: true });
  const row = await save(info.key, { google_sync_status: "pending", google_sync_error: LIMIT_MSG, next_retry_at: until, updated_by: by });
  return { row, queued: true, message: LIMIT_MSG, nextRetryAt: until, notInvited: row?.not_invited || [] };
}

async function fail(key: string, e: unknown, by: string) {
  // A failed time change / resend on a still-valid event keeps its Meet link but shows Sync Failed.
  await adminClient().from(T).update({ google_sync_status: "failed", google_sync_error: explain(e).slice(0, 500), updated_at: new Date().toISOString(), updated_by: by })
    .eq("occurrence_key", key).then(() => {}, () => {});
}

async function requireOrganizer() {
  if (!googleConfig.clientId || !googleConfig.clientSecret) throw new MeetError(503, "NOT_CONFIGURED", "Google is not set up yet — ask the admin to add the Google OAuth client to the server.");
  const org = await loadOrganizer(), act = currentActor();
  if (act.kind === "trainer") {
    if (!act.refreshToken) throw new MeetError(409, "TRAINER_NOT_CONNECTED", "The trainer's Google Meet account is not connected.");
    return { ...org, calendarId: "primary", organizerEmail: act.email };
  }
  if (!org.refreshToken) throw new MeetError(503, "NOT_CONNECTED", "The Broken English Google account is not connected yet.");
  return org;
}
const ownerFields = (ev: any) => {
  const act = currentActor();
  return act.kind === "trainer"
    ? { google_organizer_kind: "trainer", google_organizer_employee_id: act.employeeId, google_organizer_email: String(ev?.organizer?.email || act.email || "").toLowerCase() || null }
    : { google_organizer_kind: "fallback", google_organizer_employee_id: null, google_organizer_email: String(ev?.organizer?.email || "").toLowerCase() || null };
};
/** Trainer-owned meeting: the trainer IS the host — no co-host step. */
function ownerHost(info: ClassInfo, row: any) {
  return adminClient().from(T).update({ trainer_email: currentActor().email, trainer_meet_role: "OWNER", cohost_status: "assigned", cohost_error: null, updated_at: new Date().toISOString() })
    .eq("occurrence_key", info.key).select().maybeSingle().then((r) => (r.error ? row : r.data || row), () => row);
}

/** Wait briefly for Google to finish attaching the Meet conference. */
async function settle(calendarId: string, ev: any) {
  for (let i = 0; i < 4 && Cal.meetFromEvent(ev).pending; i++) {
    await new Promise((r) => setTimeout(r, 900));
    ev = await Cal.getEvent(calendarId, ev.id);
  }
  return ev;
}

async function linkFields(org: { calendarId: string; organizerEmail: string | null }, ev: any, info: ClassInfo, reminders: number[]) {
  const m = Cal.meetFromEvent(ev);
  if (!m.url) throw new MeetError(502, "NO_MEET", m.failed ? "Google could not create a Meet link for this event (Meet may be disabled for the organizer account)." : "Google created the event but has not attached a Meet link yet — use Retry Sync.");
  const space = m.code ? await getSpaceByMeetingCode(m.code) : null;
  const { invited, notInvited } = attendeesOf(info);
  const v = verifyAttendees(info, ev), now = new Date().toISOString();
  // "Synced" only when every required part is confirmed by Google's own answer.
  let status = "synced", err: string | null = null, next: string | null = null;
  if (v.trainer === "missing_email") { status = "failed"; err = "The trainer has no email address — add it (HR employee record) and the invitation is sent."; }
  else if (v.trainer === "not_configured") { status = "failed"; err = "No trainer is assigned to this class."; }
  else if (v.trainer === "failed" || v.review === "failed") { status = "pending"; err = "Google did not confirm every invitation yet. The system will retry automatically."; next = new Date(Date.now() + RETRY.transient(1)).toISOString(); }
  return {
    ...rowFields(info), google_calendar_id: org.calendarId, google_calendar_event_id: ev.id, google_meet_url: m.url, google_meet_code: m.code,
    google_meet_space_name: space?.name || null, organizer_email: ev.organizer?.email || org.organizerEmail,
    google_sync_status: status, google_sync_error: err, last_google_sync_at: now,
    reminder_minutes: reminders, invited, not_invited: notInvited,
    calendar_event_status: "ok", meet_status: "ok", trainer_invite_status: v.trainer, review_invite_status: v.review,
    trainer_calendar_invited: v.trainer === "ok", last_verified_at: now, last_sync_attempt_at: now, next_retry_at: next,
    ...(status === "synced" ? { sync_attempts: 0, last_error_status: null, last_error_reason: null } : {}),
  };
}

/** Is the trainer / review address really an attendee of the event Google returned? */
function verifyAttendees(info: ClassInfo, ev: any) {
  const got = new Set((ev?.attendees || []).map((x: any) => String(x.email || "").trim().toLowerCase()));
  const t = info.trainer?.email || null;
  // Trainer-owned: Google must report the trainer's own account as the ORGANIZER.
  if (trainerOwns()) {
    const own = String(currentActor().email || "").toLowerCase(), org = String(ev?.organizer?.email || "").toLowerCase();
    return { trainer: org && org === own ? "ok" : "failed", review: !info.reviewEmail ? "not_configured" : got.has(info.reviewEmail) ? "ok" : "failed" };
  }
  return {
    trainer: !info.trainer ? "not_configured" : !t ? "missing_email" : got.has(t) ? "ok" : "failed",
    review: !info.reviewEmail ? "not_configured" : got.has(info.reviewEmail) ? "ok" : "failed",
  };
}

const newConference = () => ({ createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } });

export const TRAINER_NOT_CONNECTED_MSG = "Trainer Google Meet account not connected.";

/** opts.fallback = Academic team explicitly chose the central account (marked "Fallback organizer").
 *  opts.fresh = recreate (ignore the existing event / room — used to move a class to its trainer). */
export async function createClassMeeting(a: JarvisAuthContext, key: string, hint: { start?: string } = {}, opts: { fallback?: boolean; fresh?: boolean } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can create Meet links.");
  const info = await resolveClass(key, hint);
  const existing = await getRow(key);
  if (existing?.class_status === "cancelled") throw new MeetError(409, "CANCELLED", "This class is cancelled.");
  // Approved trainer leave covering this class → it is not expected to happen: no Meet is made.
  // (Existing rows / historical Meet records are never touched here.)
  if (info.trainerId) {
    const { data: t } = await adminClient().from("trainers").select("id,hr_employee_id").eq("id", info.trainerId).maybeSingle();
    const lv = t ? (await loadLeaveIndex(adminClient(), info.date, info.date, [t])).leaveFor(t.id, info.date, info.startMin, info.endMin) : null;
    if (lv) throw new MeetError(409, "TRAINER_LEAVE", `The trainer is on approved leave for this class (${lv.start_date}${lv.end_date && lv.end_date !== lv.start_date ? " to " + lv.end_date : ""}) — no Meet link is created.`);
  }
  if (!opts.fresh && existing?.google_calendar_event_id && existing.google_meet_url && existing.google_sync_status === "synced") {
    return { row: existing, already: true, notInvited: existing.not_invited || [] };
  }
  // The assigned trainer's own Google account owns the meeting. Never a silent fallback.
  const owner = opts.fallback ? ORG : await actorForTrainer(info.trainerId);
  if (!owner) {
    await adminClient().from(T).upsert({ ...rowFields(info), google_sync_status: "pending", created_by: a.email }, { onConflict: "occurrence_key", ignoreDuplicates: true });
    await save(key, { google_sync_status: "failed", google_sync_error: TRAINER_NOT_CONNECTED_MSG + ` Trainer: ${info.trainer?.name || "not assigned"}.`, last_error_reason: "TRAINER_NOT_CONNECTED", next_retry_at: null, updated_by: a.email });
    throw new MeetError(409, "TRAINER_NOT_CONNECTED", `${TRAINER_NOT_CONNECTED_MSG} Trainer: ${info.trainer?.name || "not assigned"}.`);
  }
  return runAs(owner, () => createAsOwner(a, key, info, opts.fresh ? null : existing));
}

async function createAsOwner(a: JarvisAuthContext, key: string, info: ClassInfo, existing: any) {
  const org = await requireOrganizer();
  // Google limited the organizer → queue the class, don't call Google.
  const pause = await calendarPause();
  if (pause) return queueForLater(info, pause.until, a.email);
  await claim(info, a.email);
  try {
    const reminders = existing?.reminder_minutes?.length ? existing.reminder_minutes : org.defaultReminders;
    const body = eventBody(info, reminders);
    const id = await eventIdFor(key);
    let ev: any;
    // The Meet room is created by the app as an OPEN space (anyone with the link joins directly)
    // and attached to the Calendar event; Calendar-made rooms are invite-only.
    // Access decided by the server: CONTROLLED (trusted, trainer co-host admits others) once the
    // organizer can grant co-host (Google Workspace); an OPEN link while it can't (personal
    // Gmail) — otherwise uninvited students would wait with nobody able to admit them.
    // Trainer-owned: TRUSTED room — invited guests join directly, anyone else asks to join and the
    // trainer (the owner) admits them. Never an open room. Fallback keeps the earlier policy.
    const access = trainerOwns() ? "TRUSTED" : (await cohostSupported()) ? "TRUSTED" : "OPEN";
    // One Meet room per class: a room made by an earlier attempt that never reached Calendar
    // (e.g. Google limited the event) is reused — retries never create another room. Only a room
    // of the SAME owner is reused.
    const sameOwner = (existing?.google_organizer_kind || "fallback") === (trainerOwns() ? "trainer" : "fallback")
      && (!trainerOwns() || existing?.google_organizer_employee_id === currentActor().employeeId);
    let space: { name: string; meetingUri: string; meetingCode: string } | null =
      sameOwner && !existing?.google_calendar_event_id && existing?.google_meet_space_name && existing?.google_meet_code
        ? { name: existing.google_meet_space_name, meetingUri: "https://meet.google.com/" + existing.google_meet_code, meetingCode: existing.google_meet_code } : null;
    // Mark the owner early (so a retry reuses this room) — only while the class has no event yet;
    // a class being MOVED keeps its current owner until the new event exists.
    if (trainerOwns()) await adminClient().from(T).update({ google_organizer_kind: "trainer", google_organizer_employee_id: currentActor().employeeId, google_organizer_email: currentActor().email })
      .eq("occurrence_key", key).is("google_calendar_event_id", null).then(() => {}, () => {});
    if (!space) {
      space = await createSpace(access).catch(() => null);
      if (space) await save(key, { google_meet_space_name: space.name, google_meet_code: space.meetingCode }).catch(() => {});
    }
    const conference = space ? conferenceFor(space) : newConference();
    try {
      ev = await Cal.insertEvent(org.calendarId, { ...body, id, conferenceData: conference });
    } catch (e) {
      if (!(e instanceof GoogleApiError) || e.status !== 409) throw e;
      // The event already exists (an earlier attempt reached Google): adopt it — never a second one.
      // Only an event this account ORGANIZES is adopted; an invitation copy of someone else's
      // event (same id in this calendar) is never taken over.
      ev = await Cal.getEvent(org.calendarId, id);
      if (!ev?.organizer?.self) throw new MeetError(409, "ID_CONFLICT", `This calendar already has an invitation with the class's event id, organized by ${ev?.organizer?.email || "another account"} — not taken over.`);
      const reopen = ev.status === "cancelled";
      ev = await Cal.patchEvent(org.calendarId, id, { ...body, ...(reopen ? { status: "confirmed" } : {}), ...(Cal.meetFromEvent(ev).url ? {} : { conferenceData: conference }) }, reopen);
    }
    await clearPause();
    ev = await settle(org.calendarId, ev);
    // Ownership verified from Google: a trainer-owned class must be organized by the trainer's account.
    if (trainerOwns() && !ev?.organizer?.self && String(ev?.organizer?.email || "").toLowerCase() !== String(currentActor().email || "").toLowerCase())
      throw new MeetError(502, "NOT_ORGANIZER", `Google reports ${ev?.organizer?.email || "another account"} as organizer, not ${currentActor().email} — not marked as the trainer's meeting.`);
    const row0 = await save(key, { ...(await linkFields(org, ev, info, reminders)), ...ownerFields(ev), class_status: "scheduled", created_by: existing?.created_by || a.email, updated_by: a.email });
    const row = await setAccess(key, row0, space && Cal.meetFromEvent(ev).code === space.meetingCode && access === "OPEN" ? "open" : "trusted");
    await logEvent(key, "Meet created", (row?.google_meet_url || "") + " · organizer " + (row?.google_organizer_email || "?") + (trainerOwns() ? " (trainer)" : " (fallback organizer)"), a.email);
    await inviteEvents(key, row, a.email, false);
    const withHost = await assignCohost(info, row, a.email);
    return { row: withHost, already: false, notInvited: withHost?.not_invited || [] };
  } catch (e) {
    return handleSyncError(key, e, a.email);
  }
}

/** Mirrors the ERP's current time/attendees onto the SAME event. Anyone who can see the class may
 *  trigger it (e.g. a trainer who just postponed their own class) — the data comes from the ERP. */
export async function updateClassMeeting(a: JarvisAuthContext, key: string, hint: { start?: string } = {}, why: "time" | "resend" | "retry" = "time") {
  const info = await resolveClass(key, hint);
  if (!canView(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only update your own classes.");
  const row = await getRow(key);
  if (!row?.google_calendar_event_id || row.class_status === "cancelled") return { row, skipped: true };
  // A trainer-owned meeting whose class was given to ANOTHER trainer lives in the old trainer's
  // calendar — move it to the new trainer (create as them, then cancel the old event).
  if (row.google_organizer_kind === "trainer" && canManage(a)) {
    const emp = await employeeOfTrainer(info.trainerId);
    if (emp && emp !== row.google_organizer_employee_id) return recreateWithTrainer(a, key, hint);
  }
  return runAs(await actorForRow(row), () => updateAsOwner(a, key, hint, why, info, row));
}

async function updateAsOwner(a: JarvisAuthContext, key: string, hint: { start?: string }, why: "time" | "resend" | "retry", info: ClassInfo, row: any) {
  const org = await requireOrganizer();
  const pause = await calendarPause();
  if (pause) return { ...(await queueForLater(info, pause.until, a.email)), skipped: true };
  await claim(info, a.email);
  try {
    const reminders = row.reminder_minutes?.length ? row.reminder_minutes : org.defaultReminders;
    const cal = row.google_calendar_id || org.calendarId;
    // Read the event first and write ONLY what differs. Invitation emails (sendUpdates=all) go out
    // only when the time or the guest list changes, or on an explicit Resend — a retry / check of
    // an unchanged event costs one read and sends nobody another email.
    const body: any = { ...eventBody(info, reminders), status: "confirmed" };
    let ev: any = await Cal.getEvent(cal, row.google_calendar_event_id);
    const d = eventDiff(ev, body);
    if (d.restore || d.time || d.guests || why === "resend") ev = await Cal.patchEvent(cal, ev.id, body, true);
    else if (d.text) ev = await Cal.patchEvent(cal, ev.id, body, false);
    if (!Cal.meetFromEvent(ev).url) ev = await Cal.patchEvent(cal, ev.id, { conferenceData: newConference() }, false);
    if (d.restore || d.time || d.guests || d.text || why === "resend") await clearPause();
    ev = await settle(cal, ev);
    const saved = await save(key, { ...(await linkFields({ ...org, calendarId: cal }, ev, info, reminders)), updated_by: a.email });
    if (row.trainer_id && info.trainerId && row.trainer_id !== info.trainerId) await logEvent(key, "Trainer changed", info.trainer?.name || null, a.email);
    if (why === "resend") await inviteEvents(key, saved, a.email, true);
    else if (why === "time" && row.start_time !== saved?.start_time) await logEvent(key, "Time changed", `${fmt12(toMin(row.start_time) ?? 0)} → ${fmt12(info.startMin)}`, a.email);
    else if (why === "retry") await logEvent(key, "Synced with Google", null, a.email);
    const withHost = await assignCohost(info, saved, a.email);
    return { row: withHost, skipped: false, notInvited: withHost?.not_invited || [] };
  } catch (e) {
    return handleSyncError(key, e, a.email);
  }
}

/** What differs between Google's event and what the ERP says it should be. */
export function eventDiff(ev: any, body: any) {
  const restore = !ev || ev.status === "cancelled";
  const t = (x: any) => Date.parse(String(x?.dateTime || "") + (/[zZ]|[+-]\d\d:\d\d$/.test(String(x?.dateTime || "")) ? "" : "+05:30"));
  const time = !restore && (t(ev.start) !== t(body.start) || t(ev.end) !== t(body.end));
  const have = new Set((ev?.attendees || []).filter((x: any) => !x.organizer && !x.self).map((x: any) => String(x.email || "").toLowerCase()));
  const want = new Set((body.attendees || []).map((x: any) => String(x.email || "").toLowerCase()));
  const guests = !restore && (have.size !== want.size || [...want].some((e) => !have.has(e)));
  const rem = (r: any) => JSON.stringify(((r?.overrides) || []).map((o: any) => o.method + o.minutes).sort());
  const text = !restore && (ev.summary !== body.summary || (ev.description || "") !== body.description || rem(ev.reminders) !== rem(body.reminders));
  return { restore, time, guests, text };
}

/** Move a class meeting to the assigned trainer's own Google account (admin action, or trainer
 *  reassignment): create the NEW event + room as the trainer first, then cancel the OLD event
 *  (attendees get Google's update). Only before the class starts. */
export async function recreateWithTrainer(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only the Academic team can move a Meet to the trainer.");
  const info = await resolveClass(key, hint);
  const row = await getRow(key);
  if (!row?.google_calendar_event_id || row.class_status === "cancelled") return createClassMeeting(a, key, hint);
  if (row.live_status === "live" || row.live_status === "ended" || Date.now() >= new Date(istTs(info.date, info.startMin)).getTime())
    throw new MeetError(409, "STARTED", "This class has already started — the Meet can't be moved now.");
  const trainer = await actorForTrainer(info.trainerId);
  if (!trainer) throw new MeetError(409, "TRAINER_NOT_CONNECTED", `${TRAINER_NOT_CONNECTED_MSG} Trainer: ${info.trainer?.name || "not assigned"}.`);
  if (row.google_organizer_kind === "trainer" && row.google_organizer_employee_id === trainer.employeeId) return { row, already: true };
  const tPause = await runAs(trainer, () => calendarPause());
  if (tPause) throw new MeetError(429, "GOOGLE_LIMITED", `Google is limiting ${trainer.email} right now — the class will move to the trainer's account automatically later.`);
  // Old account limited right now: only move if the old event can be remembered and cancelled
  // later (migration 20261023) — otherwise students would keep two invitations.
  const oldActor = await actorForRow(row);
  if (await runAs(oldActor, () => calendarPause()) && !(await supersededReady()))
    throw new MeetError(429, "GOOGLE_LIMITED", "Google is limiting the current organizer — the class will move to the trainer's account automatically later.");
  const old = { calendar_id: row.google_calendar_id || "primary", event_id: row.google_calendar_event_id, kind: row.google_organizer_kind || "fallback", employee_id: row.google_organizer_employee_id || null, meet_url: row.google_meet_url || null };
  // A failed move leaves the class exactly as it was (old Meet keeps working).
  const restore = () => save(key, { google_sync_status: row.google_sync_status, google_sync_error: row.google_sync_error, next_retry_at: row.next_retry_at ?? null, last_error_reason: row.last_error_reason ?? null, last_error_status: row.last_error_status ?? null, google_meet_space_name: row.google_meet_space_name ?? null, google_meet_code: row.google_meet_code ?? null }).catch(() => null);
  let made: any;
  try { made = await createClassMeeting(a, key, hint, { fresh: true }); }
  catch (e) { await restore(); await logEvent(key, "Move to the trainer's Google account failed", explain(e).slice(0, 300), a.email); throw e; }
  if (!made?.row?.google_calendar_event_id || made.row.google_organizer_kind !== "trainer" || made.row.google_calendar_event_id === old.event_id) { await restore(); return made; }
  const res = await cancelSuperseded(key, old, a.email);
  await logEvent(key, "Meet moved to the trainer's Google account", made.row.google_organizer_email || null, a.email);
  return { ...made, row: res || made.row, moved: true };
}

let supReady: boolean | null = null;
async function supersededReady() {
  if (supReady === null) { const { error } = await adminClient().from(T).select("superseded_event").limit(1); supReady = !error; }
  return supReady;
}

/** Cancel the old event of a moved class as ITS owner. If that account is limited by Google (or
 *  the cancel fails for a temporary reason) it is remembered in superseded_event and the queue
 *  cancels it later — students never keep two invitations. */
async function cancelSuperseded(key: string, old: any, by: string) {
  const actor = old.kind === "trainer" && old.employee_id ? (await actorForEmployee(old.employee_id)) : ORG;
  if (!actor) { await logEvent(key, "Old Meet not cancelled — its Google account is disconnected", old.meet_url, by); return save(key, { superseded_event: null }).catch(() => null); }
  return runAs(actor, async () => {
    if (await calendarPause()) {
      await logEvent(key, "Old Meet will be cancelled when Google allows", old.meet_url, by);
      return save(key, { superseded_event: old }).catch(() => null);
    }
    try {
      await Cal.cancelEvent(old.calendar_id, old.event_id);
      await logEvent(key, "Old Meet cancelled", old.meet_url, by);
      return save(key, { superseded_event: null }).catch(() => null);
    } catch (e) {
      const g = classify(e);
      if (g.kind === "calendar_limit") await pauseCalendar(g);
      if (g.kind === "calendar_limit" || g.kind === "rate_limit" || g.kind === "transient") {
        await logEvent(key, "Old Meet will be cancelled when Google allows", old.meet_url, by);
        return save(key, { superseded_event: old }).catch(() => null);
      }
      await logEvent(key, "Old Meet could not be cancelled", explain(e).slice(0, 300), by);
      return save(key, { superseded_event: null }).catch(() => null);
    }
  });
}

export async function resendInvitations(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can send invitations.");
  const row = await getRow(key);
  if (!row?.google_calendar_event_id) return createClassMeeting(a, key, hint);
  return updateClassMeeting(a, key, hint, "resend");
}

export async function retrySync(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can retry a sync.");
  const row = await getRow(key);
  return row?.google_calendar_event_id ? updateClassMeeting(a, key, hint, "retry") : createClassMeeting(a, key, hint);
}

export async function cancelClassMeeting(a: JarvisAuthContext, key: string, reason: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can cancel a class.");
  const info = await resolveClass(key, hint);
  let row = await getRow(key);
  if (row?.class_status === "cancelled") return { row, already: true };
  if (!row) {
    await adminClient().from(T).upsert({ ...rowFields(info), created_by: a.email }, { onConflict: "occurrence_key", ignoreDuplicates: true });
    row = await getRow(key);
  }
  // ERP first: the class is cancelled even if Google is unreachable (shown as Sync Failed → Retry).
  const cancelled = { class_status: "cancelled", cancelled_by: a.email, cancelled_at: new Date().toISOString(), google_sync_error: reason ? `Reason: ${reason}`.slice(0, 500) : null, updated_by: a.email };
  await logEvent(key, "Class cancelled", reason || null, a.email);
  if (!row.google_calendar_event_id) return { row: await save(key, { ...cancelled, google_sync_status: "pending" }), already: false };
  await save(key, cancelled);
  const pause = await calendarPause();
  if (pause) return { row: await save(key, { google_sync_status: "pending", next_retry_at: pause.until }), already: false, queued: true, message: "Class cancelled. " + LIMIT_MSG };
  try {
    await Cal.cancelEvent(row.google_calendar_id || (await loadOrganizer()).calendarId, row.google_calendar_event_id);
    return { row: await save(key, { google_sync_status: "cancelled", last_google_sync_at: new Date().toISOString() }), already: false };
  } catch (e) {
    const g = classify(e);
    if (g.kind === "calendar_limit" || g.kind === "rate_limit" || g.kind === "transient") {
      const next = g.kind === "calendar_limit" ? await pauseCalendar(g) : new Date(Date.now() + RETRY.rate(1)).toISOString();
      return { row: await save(key, { google_sync_status: "pending", next_retry_at: next, last_error_status: g.status, last_error_reason: g.reason || g.kind }), already: false, queued: true, message: "Class cancelled. " + LIMIT_MSG };
    }
    await fail(key, e, a.email);
    throw new MeetError(502, "GOOGLE", "The class is cancelled in the ERP, but Google Calendar could not be updated: " + explain(e) + " — use Retry Sync.");
  }
}

/** Retry of a cancellation that didn't reach Google. */
export async function retryCancel(a: JarvisAuthContext, key: string) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can retry a sync.");
  const row = await getRow(key);
  if (!row?.google_calendar_event_id) return { row };
  const pause = await calendarPause();
  if (pause) return { row: await save(key, { google_sync_status: "pending", next_retry_at: pause.until }), queued: true };
  try {
    await Cal.cancelEvent(row.google_calendar_id || (await loadOrganizer()).calendarId, row.google_calendar_event_id);
    return { row: await save(key, { google_sync_status: "cancelled", google_sync_error: null, last_google_sync_at: new Date().toISOString() }) };
  } catch (e) {
    const g = classify(e);
    if (g.kind === "calendar_limit" || g.kind === "rate_limit" || g.kind === "transient") {
      const next = g.kind === "calendar_limit" ? await pauseCalendar(g) : new Date(Date.now() + RETRY.rate((row.sync_attempts || 0) + 1)).toISOString();
      return { row: await save(key, { google_sync_status: "pending", next_retry_at: next, sync_attempts: (row.sync_attempts || 0) + 1, last_error_status: g.status, last_error_reason: g.reason || g.kind }), queued: true };
    }
    await fail(key, e, a.email); throw e;
  }
}

/** Academic team fills a missing trainer email: HR record (personal_email) — never the login email. */
export async function setTrainerEmail(a: JarvisAuthContext, key: string, email: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only the Academic team can update trainer emails.");
  const em = String(email || "").trim().toLowerCase();
  if (!isEmail(em)) throw new MeetError(400, "BAD_EMAIL", "Enter a valid email address.");
  const info = await resolveClass(key, hint);
  if (!info.trainerId) throw new MeetError(409, "NO_TRAINER", "This class has no trainer assigned.");
  const sb = adminClient();
  const { data: t } = await sb.from("trainers").select("id,hr_employee_id").eq("id", info.trainerId).maybeSingle();
  const r = t?.hr_employee_id
    ? await sb.from("hr_employees").update({ personal_email: em }).eq("id", t.hr_employee_id)
    : await sb.from("trainers").update({ portal_email: em }).eq("id", info.trainerId);
  if (r.error) throw new MeetError(500, "DB", "Could not save the email: " + r.error.message);
  await logEvent(key, "Trainer email added", em, a.email);
  const row = await getRow(key);
  return row?.google_calendar_event_id ? updateClassMeeting(a, key, hint, "resend") : { row };
}

// ── Live: Join Live / End Class (ERP activity only — never the official duration) ─────────

const canRun = (a: JarvisAuthContext, trainerId: string | null) =>
  canManage(a) || (can(a, "academic.own") && !!a.trainerId && a.trainerId === trainerId);

const EARLY_MS = 30 * 60_000;

export async function joinLive(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  const info = await resolveClass(key, hint);
  if (!canView(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only join your own classes.");
  const row = await getRow(key);
  if (!row?.google_meet_url || row.class_status === "cancelled") throw new MeetError(409, "NO_MEET", "This class has no active Meet link.");
  await logEvent(key, "Joined live", a.name, a.email);
  if (row.live_status === "ended") return { row };
  // Only the trainer / Academic team's join marks the class live — and only from 30 min before
  // the start (opening the Meet early, e.g. to test it, doesn't start or end the class).
  if (!canRun(a, info.trainerId)) return { row };
  if (Date.now() < new Date(istTs(info.date, info.startMin)).getTime() - EARLY_MS) return { row, early: true };
  return { row: await save(key, { live_status: "live", joined_at: row.joined_at || new Date().toISOString(), joined_by: row.joined_by || a.email }) };
}

export async function endClass(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  const info = await resolveClass(key, hint);
  if (!canRun(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "Only the class trainer or the Academic team can end this class.");
  const row = await getRow(key);
  if (!row?.google_meet_url) throw new MeetError(409, "NO_MEET", "This class has no Meet.");
  if (row.live_status !== "live" && Date.now() < new Date(istTs(info.date, info.startMin)).getTime())
    throw new MeetError(409, "NOT_STARTED", "This class hasn't started yet.");
  if (row.live_status !== "ended") {
    await save(key, { live_status: "ended", ended_at: new Date().toISOString(), ended_by: a.email, meet_sync_status: "pending", meet_sync_error: null });
    await logEvent(key, "Class ended in ERP", a.name, a.email);
  }
  // Start the Meet report sync now; if Google hasn't published it yet it stays "waiting".
  return syncMeetReport(a, key, hint);
}

// ── Meet report from Google conference records ───────────────────────────────────────────

const normName = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function nameScore(display: string, name: string) {
  const d = normName(display), n = normName(name);
  if (!d || !n) return 0;
  if (d === n) return 3;
  if ((d.length >= 3 && n.includes(d)) || (n.length >= 3 && d.includes(n))) return 2;
  return d.split(" ")[0] === n.split(" ")[0] ? 1 : 0;
}
/** Total minutes covered by possibly-overlapping [start, end] ms intervals. */
function mergedMinutes(iv: [number, number][]) {
  const s = iv.filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [x, y] of s) {
    if (x > ce) { if (ce > cs) total += ce - cs; cs = x; ce = y; } else ce = Math.max(ce, y);
  }
  if (ce > cs) total += ce - cs;
  return Math.round(total / 60000);
}

export async function syncMeetReport(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  const info = await resolveClass(key, hint);
  if (!canView(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only see your own classes.");
  let row = await getRow(key);
  if (!row?.google_meet_url) throw new MeetError(409, "NO_MEET", "This class has no Meet.");
  try {
    let space = row.google_meet_space_name;
    if (!space && row.google_meet_code) { space = (await getSpaceByMeetingCode(row.google_meet_code))?.name || null; if (space) await save(key, { google_meet_space_name: space }); }
    if (!space) throw new MeetError(502, "NO_SPACE", "Google did not return the Meet space for this link.");

    const schedStart = new Date(istTs(info.date, info.startMin)).getTime(), schedEnd = new Date(istTs(info.date, info.endMin)).getTime();
    // Only the call for THIS class: started from 30 min before the scheduled start (a test or
    // early click on the link must not count) and lasted at least a minute.
    if (Date.now() < schedStart) {
      row = await save(key, { meet_sync_status: "waiting", meet_sync_error: "The class hasn't started yet — the Meet report is available after the class." });
      return { row, waiting: true, message: row?.meet_sync_error };
    }
    const records = (await listConferenceRecords(space)).filter((r: any) => {
      const t = new Date(r.startTime).getTime();
      const len = r.endTime ? new Date(r.endTime).getTime() - t : Infinity;
      return t >= schedStart - 30 * 60e3 && t <= schedEnd + 6 * 3600e3 && len >= 60e3;
    });
    if (!records.length || records.some((r: any) => !r.endTime)) {
      const endedMinsAgo = row.ended_at ? (Date.now() - new Date(row.ended_at).getTime()) / 60000 : 0;
      const msg = records.length
        ? "The Meet is still in progress — the report is ready once everyone has left."
        : endedMinsAgo > 30
          ? "Google Meet has no call for this class — nobody joined this Meet link, or the class ran on a different link."
          : "Google hasn't published the Meet report yet — it appears a few minutes after everyone leaves the call.";
      row = await save(key, { meet_sync_status: "waiting", meet_sync_error: msg });
      return { row, waiting: true, message: msg };
    }

    // Everyone who joined, with each of their sessions.
    const people: { display: string; kind: string; iv: [number, number][] }[] = [];
    for (const rec of records) {
      for (const p of await listParticipants(rec.name)) {
        const display = p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || "Guest";
        const kind = p.signedinUser ? "signed_in" : p.anonymousUser ? "guest" : p.phoneUser ? "phone" : "other";
        let iv: [number, number][] = (await listParticipantSessions(p.name)).map((x: any) => [new Date(x.startTime).getTime(), new Date(x.endTime || rec.endTime).getTime()]);
        if (!iv.length) iv = [[new Date(p.earliestStartTime).getTime(), new Date(p.latestEndTime || rec.endTime).getTime()]];
        people.push({ display, kind, iv });
      }
    }

    // Match Meet display names to the class trainer / students (Meet does not expose emails).
    const roster: Person[] = [info.trainer, ...info.students].filter(Boolean) as Person[];
    const byPerson = new Map<string, [number, number][]>(), unmatched: { name: string; kind: string; iv: [number, number][] }[] = [];
    const matchOf = new Map<string, Person>();
    for (const p of people) {
      const scored = roster.map((r) => ({ r, s: nameScore(p.display, r.name) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
      const best = scored[0] && (!scored[1] || scored[1].s < scored[0].s) ? scored[0].r : null;
      if (best) { byPerson.set(best.id, [...(byPerson.get(best.id) || []), ...p.iv]); matchOf.set(best.id, best); }
      else unmatched.push({ name: p.display, kind: p.kind, iv: p.iv });
    }

    const starts = records.map((r: any) => new Date(r.startTime).getTime()), ends = records.map((r: any) => new Date(r.endTime).getTime());
    const actualStart = Math.min(...starts), actualEnd = Math.max(...ends);
    const tIv = info.trainer ? byPerson.get(info.trainer.id) || [] : [];
    const schedDur = info.endMin - info.startMin;
    const presentAt = Math.max(5, Math.round(schedDur * 0.5));
    const iso = (t: number) => new Date(t).toISOString();

    const participants = [
      ...[...byPerson.entries()].map(([id, iv]) => {
        const r = matchOf.get(id)!;
        return { name: r.name, role: r.role, id, minutes: mergedMinutes(iv), first: iso(Math.min(...iv.map((x) => x[0]))), last: iso(Math.max(...iv.map((x) => x[1]))), sessions: iv.length };
      }),
      ...unmatched.map((u) => ({ name: u.name, role: "unmatched", id: null, kind: u.kind, minutes: mergedMinutes(u.iv), first: iso(Math.min(...u.iv.map((x) => x[0]))), last: iso(Math.max(...u.iv.map((x) => x[1]))), sessions: u.iv.length })),
    ].sort((x, y) => y.minutes - x.minutes);

    const suggestion = info.students.map((s) => {
      const iv = byPerson.get(s.id) || [];
      const minutes = mergedMinutes(iv);
      return { student_id: s.id, name: s.name, minutes, suggested: minutes >= presentAt ? "present" : minutes > 0 ? "review" : "absent" };
    });

    row = await save(key, {
      google_conference_record: records.map((r: any) => r.name).join(","),
      actual_start: iso(actualStart), actual_end: iso(actualEnd), actual_duration_minutes: Math.round((actualEnd - actualStart) / 60000),
      trainer_join_at: tIv.length ? iso(Math.min(...tIv.map((x) => x[0]))) : null,
      trainer_leave_at: tIv.length ? iso(Math.max(...tIv.map((x) => x[1]))) : null,
      trainer_presence_minutes: tIv.length ? mergedMinutes(tIv) : 0,
      meet_participants: participants, attendance_suggestion: suggestion,
      meet_sync_status: "synced", meet_sync_error: null, meet_report_synced_at: new Date().toISOString(),
      live_status: "ended", ended_at: row.ended_at || iso(actualEnd),
      attendance_review_status: row.attendance_review_status === "confirmed" ? "confirmed" : "ready",
    });
    await logEvent(key, "Meeting started", null, "Google Meet", iso(actualStart));
    if (tIv.length) await logEvent(key, "Trainer joined", info.trainer!.name, "Google Meet", iso(Math.min(...tIv.map((x) => x[0]))));
    await logEvent(key, "Meeting ended", null, "Google Meet", iso(actualEnd));
    await logEvent(key, "Meet report synced", `${row?.actual_duration_minutes} min · ${participants.length} joined`, a.email);
    return { row, waiting: false };
  } catch (e) {
    if (e instanceof MeetError && e.code === "FORBIDDEN") throw e;
    const msg = e instanceof GoogleApiError && e.status === 403
      ? "Google refused the Meet report (" + e.message + "). Reconnect the Google account in Live Classes → Settings so the Meet permission is granted."
      : explain(e);
    await save(key, { meet_sync_status: "failed", meet_sync_error: msg.slice(0, 500) });
    throw new MeetError(502, "REPORT", msg);
  }
}

/** Attendance confirmed in Class & Attendance (the only place attendance is saved) → mark reviewed. */
async function checkAttendanceConfirmed(info: ClassInfo, row: any, actor: string) {
  if (!row || row.attendance_review_status !== "ready") return row;
  const sb = adminClient();
  let done = false;
  if (info.kind === "oto") {
    const { data } = await sb.from("oto_sessions").select("status").eq("id", info.otoId).maybeSingle();
    done = ["completed", "absent", "trainer_leave"].includes(String(data?.status || ""));
  } else {
    const { data } = await sb.from("attendance").select("id").eq("batch_name", info.batchName).eq("session_date", info.date).limit(1);
    done = !!(data && data.length);
  }
  if (!done) return row;
  await logEvent(info.key, "Attendance confirmed", "Saved in Class & Attendance", actor);
  return save(info.key, { attendance_review_status: "confirmed" });
}

// ── Sync queue (concurrency 1, paced) ─────────────────────────────────────────────────────
// Classes waiting for Google (google_sync_status 'pending' + next_retry_at) are synced one at a
// time, a few seconds apart, only while Google isn't limiting the organizer. Existing synced
// classes are verified (event read back: trainer + review invited, co-host) and repaired IN
// PLACE — never a second event or Meet. Runs in the background after enqueue, and whenever an
// Academic manager has Live Classes open.
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const hintOf = (row: any) => ({ start: row?.start_time ? String(row.start_time).slice(0, 5) : undefined });

/** force: also re-check classes already marked Synced (e.g. trainer changed) — the SAME event is updated. */
export async function enqueue(a: JarvisAuthContext, keys: string[], starts: Record<string, string> = {}, force = false) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only the Academic team can create Meet links.");
  const pause = await calendarPause();
  const when = pause?.until || new Date().toISOString();
  let queued = 0, skipped = 0;
  for (const key of (keys || []).slice(0, 80)) {
    try {
      const row = await getRow(key);
      if (row?.class_status === "cancelled" || (!force && row?.google_sync_status === "synced" && row.google_meet_url)) { skipped++; continue; }
      if (!row) {
        const info = await resolveClass(key, { start: starts[key] });
        await adminClient().from(T).upsert({ ...rowFields(info), google_sync_status: "pending", created_by: a.email }, { onConflict: "occurrence_key", ignoreDuplicates: true });
      }
      await save(key, { google_sync_status: "pending", google_sync_error: pause ? LIMIT_MSG : null, next_retry_at: when, updated_by: a.email });
      queued++;
    } catch { skipped++; }
  }
  return { queued, skipped, pausedUntil: pause?.until || null };
}

export async function processQueue(a: JarvisAuthContext, budgetMs = 50_000) {
  if (!canManage(a)) return { processed: 0, verified: 0, skipped: "not_allowed" };
  if (!(await takeQueueLock(budgetMs + 15_000))) return { processed: 0, verified: 0, skipped: "busy" };
  const t0 = Date.now(), sb = adminClient(), now = new Date().toISOString();
  let processed = 0, verified = 0;
  const limitedOwners = new Set<string>();   // Google accounts that answered "limited" during this run
  // Each class is synced AS ITS OWNER (the trainer's own account, or the fallback organizer);
  // a Google limit pauses only that account.
  const runIfFree = async (owner: any, fn: () => Promise<unknown>) => {
    if (limitedOwners.has(owner.key)) return false;
    return runAs(owner, async () => {
      if (await calendarPause()) { limitedOwners.add(owner.key); return false; }
      try { await fn(); }
      catch (e) {
        if (e instanceof MeetError && e.code === "GOOGLE_LIMITED") { if (await calendarPause()) limitedOwners.add(owner.key); }
        else if (e instanceof MeetError && ["NOT_FOUND", "NOT_ACTIVE", "NO_TIME", "BAD_KEY", "CANCELLED"].includes(e.code)) {
          // the class itself can't be synced (batch removed / inactive / no time) → stop retrying it
          await save(owner.rowKey, { google_sync_status: "failed", google_sync_error: e.message, next_retry_at: null }).catch(() => {});
        }
        else throw e;
      }
      return true;
    });
  };
  const asOwner = async (row: any, fn: () => Promise<unknown>) => {
    // A class without an event belongs to its trainer. Trainer not connected → no Google call at all:
    // the class is marked "Trainer not connected" (never parked behind the Classes BRK limit).
    if (!row.google_calendar_event_id) {
      // cancelled before it ever reached Google → nothing to cancel there
      if (row.class_status === "cancelled") { await save(row.occurrence_key, { google_sync_status: "cancelled", next_retry_at: null }).catch(() => {}); return true; }
      const t = await actorForTrainer(row.trainer_id);
      if (!t) { await createClassMeeting(a, row.occurrence_key, hintOf(row)).catch(() => {}); return true; }
      return runIfFree({ ...t, rowKey: row.occurrence_key }, fn);
    }
    return runIfFree({ ...(await actorForRow(row)), rowKey: row.occurrence_key }, fn);
  };
  const horizon = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + 7 * 86400_000));
  try {
    // -1) a class marked live/ended more than 30 min before it starts (an early test click) is
    //     reset to scheduled — otherwise it couldn't be joined, moved or reported properly.
    const { data: early } = await sb.from(T).select("occurrence_key,class_date,start_time,live_status").in("live_status", ["live", "ended"]).gte("class_date", today()).limit(50).then((r) => r, () => ({ data: [] as any[] }));
    for (const r of early || []) {
      const [h, m] = String(r.start_time || "").split(":").map(Number);
      if (!Number.isFinite(h) || Date.now() >= new Date(istTs(r.class_date, h * 60 + (m || 0))).getTime() - EARLY_MS) continue;
      await save(r.occurrence_key, { live_status: "scheduled", joined_at: null, joined_by: null, ended_at: null, ended_by: null, meet_sync_status: "none", meet_sync_error: null }).catch(() => {});
      await logEvent(r.occurrence_key, "Live status reset", "The class was joined/ended before it started (test) — reset to scheduled.", "system");
    }
    // -1b) rows marked trainer-owned whose Google organizer is NOT that trainer's account (an
    //      invitation copy was adopted by the earlier event-id bug) → back to the organizer that
    //      really owns the event (Classes BRK); step 3 then moves them properly.
    const { data: mis } = await sb.from(T).select("occurrence_key,google_organizer_employee_id,google_organizer_email").eq("google_organizer_kind", "trainer").gte("class_date", today()).limit(50).then((r) => r, () => ({ data: [] as any[] }));
    for (const r of mis || []) {
      const c = await adminClient().from("employee_google_connections").select("google_email").eq("employee_id", r.google_organizer_employee_id).maybeSingle().then((x) => x.data, () => null);
      if (!c?.google_email || String(r.google_organizer_email || "").toLowerCase() === String(c.google_email).toLowerCase()) continue;
      await save(r.occurrence_key, { google_organizer_kind: "fallback", google_organizer_employee_id: null, trainer_meet_role: null, cohost_status: "pending", last_verified_at: null }).catch(() => {});
      await logEvent(r.occurrence_key, "Organizer corrected", `Google organizer is ${r.google_organizer_email} (Classes BRK), not the trainer — will move to the trainer's account.`, "system");
    }
    // 0) old Classes BRK events of classes already moved to the trainer, waiting to be cancelled
    const { data: sup } = await sb.from(T).select("occurrence_key,superseded_event").not("superseded_event", "is", null).limit(10).then((r) => r, () => ({ data: [] as any[] }));
    for (const row of sup || []) {
      if (Date.now() - t0 > budgetMs) break;
      const o = row.superseded_event || {};
      const owner = o.kind === "trainer" && o.employee_id ? await actorForEmployee(o.employee_id) : ORG;
      if (!owner) { await save(row.occurrence_key, { superseded_event: null }).catch(() => {}); continue; }
      if (limitedOwners.has(owner.key)) continue;
      await runAs(owner, async () => {
        if (await calendarPause()) { limitedOwners.add(owner.key); return; }
        await cancelSuperseded(row.occurrence_key, o, a.email).catch(() => {});
        if (await calendarPause()) limitedOwners.add(owner.key);
      });
      await sleep(1200);
    }
    // 1) classes waiting for Google (and cancellations that haven't reached Google yet)
    const { data: due } = await sb.from(T).select("*").eq("google_sync_status", "pending").gte("class_date", today())
      .or(`next_retry_at.is.null,next_retry_at.lte.${now}`).order("class_date").order("start_time").limit(10);
    for (const row of due || []) {
      if (Date.now() - t0 > budgetMs) break;
      const ran = await asOwner(row, () => row.class_status === "cancelled" ? retryCancel(a, row.occurrence_key)
        : row.google_calendar_event_id ? updateClassMeeting(a, row.occurrence_key, hintOf(row), "retry")
        : createClassMeeting(a, row.occurrence_key, hintOf(row))).catch(() => true);
      if (ran) { processed++; await sleep(2500); }
    }
    // 1b) classes with no Meet that failed on the old Classes BRK limit, or were waiting for their
    //     trainer to connect → created in the trainer's account once the trainer is connected.
    const { data: stuck } = await sb.from(T).select("*").eq("google_sync_status", "failed").eq("class_status", "scheduled").is("google_calendar_event_id", null)
      .gte("class_date", today()).lte("class_date", horizon)
      .or("google_sync_error.ilike.*limit*,last_error_reason.eq.TRAINER_NOT_CONNECTED,last_error_reason.eq.quotaExceeded").order("class_date").order("start_time").limit(15);
    for (const row of stuck || []) {
      if (Date.now() - t0 > budgetMs) break;
      const t = await actorForTrainer(row.trainer_id);
      if (!t) {
        if (row.last_error_reason !== "TRAINER_NOT_CONNECTED") await createClassMeeting(a, row.occurrence_key, hintOf(row)).catch(() => {});
        continue;
      }
      const ran = await runIfFree({ ...t, rowKey: row.occurrence_key }, () => createClassMeeting(a, row.occurrence_key, hintOf(row))).catch(() => true);
      if (ran) { processed++; await sleep(2500); }
    }
    // 2) verify + repair classes already marked Synced (read first; write only if something is missing)
    const { data: chk } = await sb.from(T).select("*").eq("google_sync_status", "synced").eq("class_status", "scheduled").gte("class_date", today())
      .or("last_verified_at.is.null,trainer_invite_status.neq.ok,cohost_status.in.(pending,failed)").order("class_date").order("start_time").limit(8);
    for (const row of chk || []) {
      if (Date.now() - t0 > budgetMs) break;
      const ran = await asOwner(row, () => updateClassMeeting(a, row.occurrence_key, hintOf(row), "retry"))
        .catch(async () => { await save(row.occurrence_key, { last_verified_at: new Date().toISOString() }).catch(() => {}); return true; });   // don't re-pick it every run
      if (ran) { verified++; await sleep(1200); }
    }
    // 3) classes still organized by Classes BRK whose trainer has connected → moved to the trainer
    //    (next 7 days, before the class starts; a few per run so neither account is flooded).
    const { data: fb } = await sb.from(T).select("*").eq("google_organizer_kind", "fallback").eq("class_status", "scheduled").eq("google_sync_status", "synced").not("google_calendar_event_id", "is", null)
      .neq("live_status", "live").neq("live_status", "ended").gte("class_date", today()).lte("class_date", horizon).order("class_date").order("start_time").limit(20);
    let moves = 0;
    for (const row of fb || []) {
      if (Date.now() - t0 > budgetMs || moves >= 5) break;
      const t = await actorForTrainer(row.trainer_id);
      if (!t || limitedOwners.has(t.key)) continue;
      try { await recreateWithTrainer(a, row.occurrence_key, hintOf(row)); moves++; processed++; await sleep(2500); }
      catch (e) { if (e instanceof MeetError && e.code === "GOOGLE_LIMITED") limitedOwners.add(t.key); }
    }
  } finally { await releaseQueueLock(); }
  const { count } = await sb.from(T).select("occurrence_key", { count: "exact", head: true }).eq("google_sync_status", "pending").gte("class_date", today());
  return { processed, verified, remaining: count || 0, pausedUntil: (await calendarPause())?.until || null };
}

export async function getMeetingDetails(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  let info: ClassInfo | null = null;
  try { info = await resolveClass(key, hint); } catch (e) { if (!(e instanceof MeetError) || e.status !== 404) throw e; }
  let row = await getRow(key);
  const trainerId = info?.trainerId ?? row?.trainer_id ?? null;
  if (!canView(a, trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only see your own classes.");
  // Don't hide drift: an event deleted directly in Google Calendar shows as Sync Failed.
  // Read-back check at most every 15 minutes per class, and never while Google is limiting us.
  const fresh = row?.last_verified_at && Date.now() - Date.parse(row.last_verified_at) < 15 * 60_000;
  if (row?.google_calendar_event_id && row.class_status === "scheduled" && row.google_sync_status === "synced" && !fresh && !(await calendarPause())) {
    try {
      const ev = await Cal.getEvent(row.google_calendar_id || "primary", row.google_calendar_event_id);
      if (ev?.status === "cancelled") row = await save(key, { google_sync_status: "failed", google_sync_error: "The event was cancelled or deleted directly in Google Calendar — use Retry Sync to restore it." });
      else if (info) { const v = verifyAttendees(info, ev); row = await save(key, { last_verified_at: new Date().toISOString(), trainer_invite_status: v.trainer, review_invite_status: v.review, trainer_calendar_invited: v.trainer === "ok" }); }
    } catch (e) {
      if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) row = await save(key, { google_sync_status: "failed", google_sync_error: "The event no longer exists in Google Calendar — use Retry Sync to restore it." });
    }
  }
  if (info) row = await checkAttendanceConfirmed(info, row, a.email);
  const people = info ? attendeesOf(info) : { invited: row?.invited || [], notInvited: row?.not_invited || [] };
  const { data: events } = await adminClient().from("academic_live_class_events").select("event,detail,actor,at").eq("occurrence_key", key).order("at", { ascending: true }).limit(100);
  return {
    row,
    class: info && { title: info.title, course: info.course, batchName: info.batchName, typeLabel: info.typeLabel, date: info.date, start: hm(info.startMin), end: hm(info.endMin % 1440), trainer: info.trainer?.name || null, students: info.students.length },
    invited: people.invited, notInvited: people.notInvited, events: events || [],
    canManage: canManage(a), canRun: info ? canRun(a, info.trainerId) : false,
  };
}
