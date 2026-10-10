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
import { GoogleApiError, loadOrganizer, googleConfig } from "../_shared/google/googleAuthService.ts";
import * as Cal from "../_shared/google/googleCalendarService.ts";
import { getSpaceByMeetingCode, listConferenceRecords, listParticipants, listParticipantSessions } from "../_shared/google/googleMeetService.ts";

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
  const BCOLS = "id,name,programme,trainer_id,trainer_name,capacity,class_duration_minutes,time_slot,status,deleted_at";
  let batch: any, date: string, startMin: number | null, endMin: number | null, trainerId: string | null, originalDate: string;
  let students: Person[] = [];

  if (k.kind === "oto") {
    const { data: o } = await sb.from("oto_sessions").select("id,batch_id,student_id,trainer_id,session_date,start_time,end_time,duration_minutes,status").eq("id", k.otoId).maybeSingle();
    if (!o) throw new MeetError(404, "NOT_FOUND", "This 1:1 session no longer exists.");
    ({ data: batch } = await sb.from("batches").select(BCOLS).eq("id", o.batch_id).maybeSingle());
    date = String(o.session_date).slice(0, 10); originalDate = date;
    startMin = toMin(o.start_time); endMin = toMin(o.end_time);
    if (startMin == null) throw new MeetError(409, "NO_TIME", "This 1:1 session has no time set yet.");
    if (endMin == null || endMin <= startMin) endMin = startMin + (Number(o.duration_minutes) || 30);
    trainerId = o.trainer_id || batch?.trainer_id || null;
    if (o.student_id) {
      const { data: s } = await sb.from("students").select("id,name,email").eq("id", o.student_id).maybeSingle();
      if (s) students = [{ role: "student", id: s.id, name: s.name || "Student", email: isEmail(s.email) ? String(s.email).trim() : null }];
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
    const { data: ss } = await sb.from("students").select("id,name,email,status").eq("batch_id", batch.id);
    students = (ss || []).filter((s: any) => String(s.status || "").toLowerCase() !== "dropped")
      .map((s: any) => ({ role: "student" as const, id: s.id, name: s.name || "Student", email: isEmail(s.email) ? String(s.email).trim() : null }));
  }

  // Trainer email — the central HR employee record (portal login email, then personal email).
  let trainer: Person | null = null;
  if (trainerId) {
    const { data: t } = await sb.from("trainers").select("id,name,hr_employee_id,portal_email").eq("id", trainerId).maybeSingle();
    let hr: any = null;
    if (t?.hr_employee_id) ({ data: hr } = await sb.from("hr_employees").select("full_name,portal_email,personal_email").eq("id", t.hr_employee_id).maybeSingle());
    const email = [hr?.portal_email, hr?.personal_email, t?.portal_email].find(isEmail);
    trainer = { role: "trainer", id: trainerId, name: hr?.full_name || t?.name || batch?.trainer_name || "Trainer", email: email ? String(email).trim() : null };
  }

  const isOne = k.kind === "oto" || Number(batch?.capacity) === 1;
  const batchName = batch?.name || "1:1 session";
  const course = String(batch?.programme || batchName).trim();
  const who = isOne ? (students[0]?.name || batchName) : batchName;
  const typeLabel = k.kind === "oto" ? "Group 1:1" : isOne ? "1:1" : "Group";
  const title = isOne && students[0] ? `Broken English | ${course} – ${who}` : `Broken English | ${batchName}`;
  const description = [
    "Broken English Online Class", "",
    `Course:\n${course}`, "",
    `Trainer:\n${trainer?.name || "To be assigned"}`, "",
    `${isOne ? "Student" : "Batch"}:\n${who}${!isOne && students.length ? ` (${students.length} students)` : ""}`, "",
    `Class Type:\n${typeLabel}`, "",
    `Time:\n${fmt12(startMin!)} – ${fmt12(endMin!)} (India time)`, "",
    "Managed through Broken English ERP.",
  ].join("\n");

  const org = await loadOrganizer();
  return { key, kind: k.kind, batchId: batch?.id || null, otoId: k.kind === "oto" ? k.otoId : null, originalDate, date, startMin: startMin!, endMin: endMin!,
    trainerId, trainer, students, batchName, course, typeLabel, isOne, title, description, reviewEmail: isEmail(org.reviewEmail) ? org.reviewEmail : null };
}

function attendeesOf(info: ClassInfo) {
  const attendees: { email: string; displayName: string }[] = [], invited: any[] = [], notInvited: any[] = [], seen = new Set<string>();
  for (const p of [info.trainer, ...info.students].filter(Boolean) as Person[]) {
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
async function eventIdFor(key: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("be-live-class|" + key)));
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

async function save(key: string, patch: Record<string, unknown>) {
  const { data, error } = await adminClient().from(T).update({ ...patch, updated_at: new Date().toISOString() }).eq("occurrence_key", key).select().maybeSingle();
  if (error) throw new MeetError(500, "DB", "The Meet link was created in Google but could not be saved in the ERP: " + error.message);
  return data;
}

function explain(e: unknown): string {
  if (e instanceof MeetError || e instanceof GoogleApiError) return e.message;
  return (e as Error)?.message || String(e);
}

async function fail(key: string, e: unknown, by: string) {
  // A failed time change / resend on a still-valid event keeps its Meet link but shows Sync Failed.
  await adminClient().from(T).update({ google_sync_status: "failed", google_sync_error: explain(e).slice(0, 500), updated_at: new Date().toISOString(), updated_by: by })
    .eq("occurrence_key", key).then(() => {}, () => {});
}

async function requireOrganizer() {
  if (!googleConfig.clientId || !googleConfig.clientSecret) throw new MeetError(503, "NOT_CONFIGURED", "Google is not set up yet — ask the admin to add the Google OAuth client to the server.");
  const org = await loadOrganizer();
  if (!org.refreshToken) throw new MeetError(503, "NOT_CONNECTED", "The Broken English Google account is not connected yet.");
  return org;
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
  return {
    ...rowFields(info), google_calendar_id: org.calendarId, google_calendar_event_id: ev.id, google_meet_url: m.url, google_meet_code: m.code,
    google_meet_space_name: space?.name || null, organizer_email: ev.organizer?.email || org.organizerEmail,
    google_sync_status: "synced", google_sync_error: null, last_google_sync_at: new Date().toISOString(),
    reminder_minutes: reminders, invited, not_invited: notInvited,
  };
}

const newConference = () => ({ createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } });

export async function createClassMeeting(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can create Meet links.");
  const info = await resolveClass(key, hint);
  const existing = await getRow(key);
  if (existing?.class_status === "cancelled") throw new MeetError(409, "CANCELLED", "This class is cancelled.");
  if (existing?.google_calendar_event_id && existing.google_meet_url && existing.google_sync_status === "synced") {
    return { row: existing, already: true, notInvited: existing.not_invited || [] };
  }
  const org = await requireOrganizer();
  await claim(info, a.email);
  try {
    const reminders = existing?.reminder_minutes?.length ? existing.reminder_minutes : org.defaultReminders;
    const body = eventBody(info, reminders);
    const id = await eventIdFor(key);
    let ev: any;
    try {
      ev = await Cal.insertEvent(org.calendarId, { ...body, id, conferenceData: newConference() });
    } catch (e) {
      if (!(e instanceof GoogleApiError) || e.status !== 409) throw e;
      // The event already exists (an earlier attempt reached Google): adopt it — never a second one.
      ev = await Cal.getEvent(org.calendarId, id);
      const reopen = ev.status === "cancelled";
      ev = await Cal.patchEvent(org.calendarId, id, { ...body, ...(reopen ? { status: "confirmed" } : {}), ...(Cal.meetFromEvent(ev).url ? {} : { conferenceData: newConference() }) }, reopen);
    }
    ev = await settle(org.calendarId, ev);
    const row = await save(key, { ...(await linkFields(org, ev, info, reminders)), class_status: "scheduled", created_by: existing?.created_by || a.email, updated_by: a.email });
    await logEvent(key, "Meet created", row?.google_meet_url || null, a.email);
    await inviteEvents(key, row, a.email, false);
    return { row, already: false, notInvited: row?.not_invited || [] };
  } catch (e) {
    await fail(key, e, a.email);
    throw e;
  }
}

/** Mirrors the ERP's current time/attendees onto the SAME event. Anyone who can see the class may
 *  trigger it (e.g. a trainer who just postponed their own class) — the data comes from the ERP. */
export async function updateClassMeeting(a: JarvisAuthContext, key: string, hint: { start?: string } = {}, why: "time" | "resend" | "retry" = "time") {
  const info = await resolveClass(key, hint);
  if (!canView(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only update your own classes.");
  const row = await getRow(key);
  if (!row?.google_calendar_event_id || row.class_status === "cancelled") return { row, skipped: true };
  const org = await requireOrganizer();
  await claim(info, a.email);
  try {
    const reminders = row.reminder_minutes?.length ? row.reminder_minutes : org.defaultReminders;
    const cal = row.google_calendar_id || org.calendarId;
    // status "confirmed" also restores an event someone cancelled directly in Google Calendar.
    let ev = await Cal.patchEvent(cal, row.google_calendar_event_id, { ...eventBody(info, reminders), status: "confirmed" }, true);
    if (!Cal.meetFromEvent(ev).url) ev = await Cal.patchEvent(cal, ev.id, { conferenceData: newConference() }, false);
    ev = await settle(cal, ev);
    const saved = await save(key, { ...(await linkFields({ ...org, calendarId: cal }, ev, info, reminders)), updated_by: a.email });
    if (why === "resend") await inviteEvents(key, saved, a.email, true);
    else if (why === "time" && row.start_time !== saved?.start_time) await logEvent(key, "Time changed", `${fmt12(toMin(row.start_time) ?? 0)} → ${fmt12(info.startMin)}`, a.email);
    else if (why === "retry") await logEvent(key, "Synced with Google", null, a.email);
    return { row: saved, skipped: false, notInvited: saved?.not_invited || [] };
  } catch (e) {
    await fail(key, e, a.email);
    throw e;
  }
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
  try {
    await Cal.cancelEvent(row.google_calendar_id || (await loadOrganizer()).calendarId, row.google_calendar_event_id);
    return { row: await save(key, { google_sync_status: "cancelled", last_google_sync_at: new Date().toISOString() }), already: false };
  } catch (e) {
    await fail(key, e, a.email);
    throw new MeetError(502, "GOOGLE", "The class is cancelled in the ERP, but Google Calendar could not be updated: " + explain(e) + " — use Retry Sync.");
  }
}

/** Retry of a cancellation that didn't reach Google. */
export async function retryCancel(a: JarvisAuthContext, key: string) {
  if (!canManage(a)) throw new MeetError(403, "FORBIDDEN", "Only Academic Head, Class Coordinator or Operations Manager can retry a sync.");
  const row = await getRow(key);
  if (!row?.google_calendar_event_id) return { row };
  try {
    await Cal.cancelEvent(row.google_calendar_id || (await loadOrganizer()).calendarId, row.google_calendar_event_id);
    return { row: await save(key, { google_sync_status: "cancelled", google_sync_error: null, last_google_sync_at: new Date().toISOString() }) };
  } catch (e) { await fail(key, e, a.email); throw e; }
}

// ── Live: Join Live / End Class (ERP activity only — never the official duration) ─────────

const canRun = (a: JarvisAuthContext, trainerId: string | null) =>
  canManage(a) || (can(a, "academic.own") && !!a.trainerId && a.trainerId === trainerId);

export async function joinLive(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  const info = await resolveClass(key, hint);
  if (!canView(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only join your own classes.");
  const row = await getRow(key);
  if (!row?.google_meet_url || row.class_status === "cancelled") throw new MeetError(409, "NO_MEET", "This class has no active Meet link.");
  await logEvent(key, "Joined live", a.name, a.email);
  if (row.live_status === "ended") return { row };
  // Only the trainer / Academic team's join marks the class live.
  if (!canRun(a, info.trainerId)) return { row };
  return { row: await save(key, { live_status: "live", joined_at: row.joined_at || new Date().toISOString(), joined_by: row.joined_by || a.email }) };
}

export async function endClass(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  const info = await resolveClass(key, hint);
  if (!canRun(a, info.trainerId)) throw new MeetError(403, "FORBIDDEN", "Only the class trainer or the Academic team can end this class.");
  const row = await getRow(key);
  if (!row?.google_meet_url) throw new MeetError(409, "NO_MEET", "This class has no Meet.");
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
    const records = (await listConferenceRecords(space)).filter((r: any) => {
      const t = new Date(r.startTime).getTime();
      return t >= schedStart - 3 * 3600e3 && t <= schedEnd + 6 * 3600e3;
    });
    if (!records.length || records.some((r: any) => !r.endTime)) {
      const msg = !records.length
        ? "Google hasn't published the Meet report yet — it appears a few minutes after everyone leaves the call."
        : "The Meet is still in progress — the report is ready once everyone has left.";
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

export async function getMeetingDetails(a: JarvisAuthContext, key: string, hint: { start?: string } = {}) {
  let info: ClassInfo | null = null;
  try { info = await resolveClass(key, hint); } catch (e) { if (!(e instanceof MeetError) || e.status !== 404) throw e; }
  let row = await getRow(key);
  const trainerId = info?.trainerId ?? row?.trainer_id ?? null;
  if (!canView(a, trainerId)) throw new MeetError(403, "FORBIDDEN", "You can only see your own classes.");
  // Don't hide drift: an event deleted directly in Google Calendar shows as Sync Failed.
  if (row?.google_calendar_event_id && row.class_status === "scheduled" && row.google_sync_status === "synced") {
    try {
      const ev = await Cal.getEvent(row.google_calendar_id || "primary", row.google_calendar_event_id);
      if (ev?.status === "cancelled") row = await save(key, { google_sync_status: "failed", google_sync_error: "The event was cancelled or deleted directly in Google Calendar — use Retry Sync to restore it." });
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
