// Read-only ERP services for Jarvis. Each function is a fixed, parameterised read of the
// EXISTING ERP tables, using the same business rules as the portals that own the data:
//
//   academicService   — academics.html Classes / Schedule / Upcoming Batches rules
//                       (batches.day_pattern + time_slot occurrences, holidays skipped,
//                       session-complete batches excluded, 1:1 sessions from oto_sessions)
//   leaveService      — hr_leave_requests, approval rule = LeavePolicy.isApproved
//   attendanceService — the shared leave/attendance engine (leave-policy.js) per employee
//   salesService      — sales.html rules (Enrolled = lead stage Enrolled + Xale CRM enrolments)
//   crmService        — leads list
//   metricsService    — manager.html overview rules
//
// No writes. No generic SQL. Only the rows needed to answer are returned to the LLM.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient } from "./auth.ts";
import { addDays, dow, fmtMinutes, isIsoDate, toWallClock, tsDay, tzDate, tzMinutes, wallNow, type DateRange } from "./time.ts";
import "./vendor/leave-policy.js";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
const LP: any = (globalThis as any).LeavePolicy;

const db = (): SupabaseClient => adminClient();

/** Fetch every row of a filtered query (PostgREST pages at 1000). */
// deno-lint-ignore no-explicit-any
async function fetchAll(table: string, select: string, filter: (q: any) => any = (q) => q, cap = 20000): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await filter(db().from(table).select(select)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────────────────
// Academic
// ─────────────────────────────────────────────────────────────────────────────────────────
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "8:30 PM", "8.30 PM", "8 pm" → minutes (same parser as academics.html). */
function timeLabelToMinutes(label: string | null | undefined): number | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(String(label || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}
function hhmmToMinutes(t: string | null | undefined): number | null {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}

export interface ClassItem {
  date: string;
  start: string;
  end: string;
  start_minutes: number | null;
  trainer: string;
  trainer_id: string | null;
  batch: string;
  batch_id: string;
  course: string;
  class_type: "Group" | "1:1" | "Group 1:1";
  student_or_group: string;
  duration_minutes: number;
  status: string;
  attendance: "marked" | "not_marked" | "not_due";
}

interface ScheduleData {
  batches: Row[];
  trainerName: Record<string, string>;
  holidays: Record<string, string>;
  markedByBatchDate: Set<string>;
  oto: Row[];
  studentName: Record<string, string>;
  batchById: Record<string, Row>;
}

async function loadSchedule(from: string, to: string, trainerId?: string | null): Promise<ScheduleData> {
  let bq = db().from("batches").select("*").eq("status", "active").is("deleted_at", null);
  if (trainerId) bq = bq.eq("trainer_id", trainerId);
  let oq = db().from("oto_sessions").select("id,batch_id,student_id,trainer_id,session_date,start_time,end_time,duration_minutes,status")
    .gte("session_date", from).lte("session_date", to);
  if (trainerId) oq = oq.eq("trainer_id", trainerId);
  const [bR, cR, tR, hR, oR] = await Promise.all([
    bq, db().from("courses").select("id,name,default_days"), db().from("trainers").select("id,name"),
    db().from("hr_holidays").select("holiday_date,name"), oq,
  ]);
  for (const r of [bR, cR, tR, hR, oR]) if (r.error) throw new Error(r.error.message);
  const courseDays: Record<string, string> = {};
  (cR.data || []).forEach((c: Row) => { courseDays[c.id] = c.default_days || ""; });
  let batches: Row[] = (bR.data || []).map((b: Row) => ({ ...b, _days: b.day_pattern || courseDays[b.course_id] || "" }));
  const names = batches.map((b) => b.name).filter(Boolean);
  // Session completion rule (academics.html): a batch whose distinct present-session count has
  // reached sessions_total no longer generates classes. Also collect which batch/date pairs
  // already have attendance saved in the requested window.
  const done: Record<string, Set<string>> = {};
  const marked = new Set<string>();
  if (names.length) {
    const att = await fetchAll("attendance", "batch_name,session_date,session_num,status", (q) => q.in("batch_name", names));
    for (const a of att) {
      const d = a.session_date ? String(a.session_date).slice(0, 10) : "";
      if (d && d >= from && d <= to) marked.add(a.batch_name + "|" + d);
      if (a.status !== "present") continue;
      (done[a.batch_name] ||= new Set()).add(a.session_date != null ? String(a.session_date) : "num_" + a.session_num);
    }
  }
  batches = batches.filter((b) => !(b.sessions_total && (done[b.name]?.size || 0) >= b.sessions_total));
  const trainerName: Record<string, string> = {};
  (tR.data || []).forEach((t: Row) => { trainerName[t.id] = t.name; });
  const holidays: Record<string, string> = {};
  (hR.data || []).forEach((h: Row) => { if (h.holiday_date) holidays[String(h.holiday_date).slice(0, 10)] = h.name || "Holiday"; });
  const oto = oR.data || [];
  const batchById: Record<string, Row> = {};
  batches.forEach((b) => { batchById[b.id] = b; });
  const missing = [...new Set(oto.map((o: Row) => o.batch_id).filter((id: string) => id && !batchById[id]))];
  if (missing.length) {
    const { data } = await db().from("batches").select("id,name,programme,trainer_id,trainer_name,capacity,class_duration_minutes").in("id", missing);
    (data || []).forEach((b: Row) => { batchById[b.id] = b; });
  }
  const sIds = [...new Set(oto.map((o: Row) => o.student_id).filter(Boolean))];
  const studentName: Record<string, string> = {};
  if (sIds.length) {
    const { data } = await db().from("students").select("id,name").in("id", sIds);
    (data || []).forEach((s: Row) => { studentName[s.id] = s.name; });
  }
  return { batches, trainerName, holidays, markedByBatchDate: marked, oto, studentName, batchById };
}

function batchOccurrences(b: Row, from: string, to: string, holidays: Record<string, string>): string[] {
  const days = String(b._days || "").split(",").map((s) => s.trim().replace(/\s*·.*$/, "")).filter((d) => d in DAY_INDEX);
  if (!days.length || timeLabelToMinutes(b.time_slot) === null) return [];
  let end = b.status === "active" ? "9999-12-31" : (b.expected_completion_date || "9999-12-31");
  if (b.group_classes_completed_at) { const g = String(b.group_classes_completed_at).slice(0, 10); if (g < end) end = g; }
  const s = (b.start_date || "0000-01-01") > from ? b.start_date : from;
  const e = end < to ? end : to;
  const want = new Set(days.map((d) => DAY_INDEX[d]));
  const out: string[] = [];
  for (let d = s; d <= e; d = addDays(d, 1)) if (want.has(dow(d)) && !holidays[d]) out.push(d);
  return out;
}

export const academicService = {
  /** Every Academic class (group, standalone 1:1, group-linked 1:1) in [from, to]. */
  async getClasses(o: { from: string; to: string; trainerId?: string | null; includeGroup?: boolean; includeOneToOne?: boolean }): Promise<ClassItem[]> {
    const S = await loadSchedule(o.from, o.to, o.trainerId);
    const today = tzDate(), nowMin = tzMinutes();
    const items: ClassItem[] = [];
    const statusOf = (date: string, st: number | null, dur: number) => {
      if (date < today) return "completed_window";
      if (date > today || st == null) return "scheduled";
      if (nowMin >= st + dur) return "finished";
      if (nowMin >= st) return "in_progress";
      return "upcoming_today";
    };
    for (const b of S.batches) {
      const one = Number(b.capacity) === 1;
      if (one ? o.includeOneToOne === false : o.includeGroup === false) continue;
      const st = timeLabelToMinutes(b.time_slot), dur = Number(b.class_duration_minutes) || 60;
      for (const date of batchOccurrences(b, o.from, o.to, S.holidays)) {
        const status = statusOf(date, st, dur);
        const due = status === "completed_window" || status === "finished" || status === "in_progress";
        items.push({
          date, start: fmtMinutes(st), end: st != null ? fmtMinutes(st + dur) : "", start_minutes: st,
          trainer: S.trainerName[b.trainer_id] || b.trainer_name || "Unassigned", trainer_id: b.trainer_id || null,
          batch: b.name, batch_id: b.id, course: b.programme || "", class_type: one ? "1:1" : "Group",
          student_or_group: one ? b.name : "Group batch", duration_minutes: dur, status,
          attendance: due ? (S.markedByBatchDate.has(b.name + "|" + date) ? "marked" : "not_marked") : "not_due",
        });
      }
    }
    if (o.includeOneToOne !== false) {
      for (const s of S.oto) {
        const b = S.batchById[s.batch_id] || {};
        const st = hhmmToMinutes(s.start_time), en = hhmmToMinutes(s.end_time);
        const dur = st != null && en != null && en > st ? en - st : (Number(s.duration_minutes) || 30);
        const date = String(s.session_date).slice(0, 10);
        items.push({
          date, start: fmtMinutes(st), end: st != null ? fmtMinutes(st + dur) : "", start_minutes: st,
          trainer: S.trainerName[s.trainer_id || b.trainer_id] || b.trainer_name || "Unassigned", trainer_id: s.trainer_id || b.trainer_id || null,
          batch: b.name || "1:1 session", batch_id: s.batch_id, course: b.programme || "", class_type: "Group 1:1",
          student_or_group: S.studentName[s.student_id] || "Student", duration_minutes: dur,
          status: String(s.status || "scheduled").toLowerCase(), attendance: s.status ? "marked" : "not_marked",
        });
      }
    }
    items.sort((a, b) => a.date === b.date ? (a.start_minutes ?? 9999) - (b.start_minutes ?? 9999) : a.date.localeCompare(b.date));
    return items;
  },

  /** Classes whose scheduled time is over but no attendance was saved (group/standalone). */
  async getUnmarkedAttendance(o: { date: string; trainerId?: string | null }) {
    const classes = (await academicService.getClasses({ from: o.date, to: o.date, trainerId: o.trainerId, includeOneToOne: true }))
      .filter((c) => c.class_type !== "Group 1:1" && c.attendance === "not_marked" && c.status !== "in_progress");
    if (!classes.length) return [];
    const ids = [...new Set(classes.map((c) => c.batch_id))];
    const { data, error } = await db().from("students").select("batch_id,name,status").in("batch_id", ids);
    if (error) throw new Error(error.message);
    const roster: Record<string, string[]> = {};
    (data || []).forEach((s: Row) => { if (!["Dropped", "Completed"].includes(s.status)) (roster[s.batch_id] ||= []).push(s.name); });
    return classes.map((c) => ({ trainer: c.trainer, batch: c.batch, course: c.course, class_time: `${c.start}–${c.end}`, date: c.date,
      students: roster[c.batch_id] || [], student_count: (roster[c.batch_id] || []).length, attendance_status: "not_submitted" }));
  },

  /** Batches about to start: status 'upcoming', or active with a future start date. */
  async getUpcomingBatches(daysAhead: number) {
    const today = tzDate(), until = addDays(today, daysAhead);
    const { data, error } = await db().from("batches")
      .select("id,name,programme,trainer_id,trainer_name,day_pattern,time_slot,start_date,status,capacity,enrollment_status,enrollment_deadline")
      .in("status", ["upcoming", "active"]).is("deleted_at", null);
    if (error) throw new Error(error.message);
    const list = (data || []).filter((b: Row) => b.status === "upcoming" ? (!b.start_date || b.start_date <= until) : (b.start_date && b.start_date > today && b.start_date <= until));
    const ids = list.map((b: Row) => b.id);
    const counts: Record<string, number> = {};
    if (ids.length) {
      const st = await db().from("students").select("batch_id,status").in("batch_id", ids);
      (st.data || []).forEach((s: Row) => { if (s.status !== "Dropped") counts[s.batch_id] = (counts[s.batch_id] || 0) + 1; });
    }
    const tr = await db().from("trainers").select("id,name");
    const tn: Record<string, string> = {}; (tr.data || []).forEach((t: Row) => { tn[t.id] = t.name; });
    return list.map((b: Row) => ({
      batch: b.name, course: b.programme || "", trainer: tn[b.trainer_id] || b.trainer_name || "Unassigned",
      start_date: b.start_date || "not set", days: b.day_pattern || "", time: b.time_slot || "",
      enrolled: counts[b.id] || 0, capacity: b.capacity ?? null, type: Number(b.capacity) === 1 ? "1:1" : "Group",
      enrollment_status: b.enrollment_status || null,
    })).sort((a: Row, b: Row) => String(a.start_date).localeCompare(String(b.start_date)));
  },

  async getTrainerDirectory() {
    const { data, error } = await db().from("trainers").select("id,name,status,hr_employee_id").eq("status", "active");
    if (error) throw new Error(error.message);
    return (data || []) as Row[];
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Leave
// ─────────────────────────────────────────────────────────────────────────────────────────
export const leaveService = {
  /** Approved leave (not cancelled) covering `date` for active trainers. */
  async getApprovedTrainerLeave(date: string) {
    const trainers = await academicService.getTrainerDirectory();
    const byEmp: Record<string, Row> = {};
    trainers.forEach((t) => { if (t.hr_employee_id) byEmp[t.hr_employee_id] = t; });
    const empIds = Object.keys(byEmp);
    if (!empIds.length) return [];
    const { data, error } = await db().from("hr_leave_requests")
      .select("employee_id,leave_type,start_date,end_date,days,half_day_type,status,manager_status,hr_status,final_treatment,cancelled_at")
      .in("employee_id", empIds).lte("start_date", date).gte("end_date", date);
    if (error) throw new Error(error.message);
    return (data || []).filter((r: Row) => !r.cancelled_at && LP.isApproved(r)).map((r: Row) => {
      const t = byEmp[r.employee_id];
      const wfh = /home|wfh/i.test(r.leave_type || "");
      return {
        trainer: t.name, trainer_id: t.id, leave_type: r.leave_type + (r.half_day_type ? ` (half day, ${r.half_day_type})` : ""),
        kind: wfh ? "work_from_home" : (r.half_day_type ? "half_day_leave" : "leave"),
        approved: true, from: r.start_date, to: r.end_date, days: r.days != null ? Number(r.days) : null,
        paid: String(r.final_treatment || "").toLowerCase().startsWith("lop") ? "unpaid (LOP)" : "per policy",
      };
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Employee attendance (shared engine: leave-policy.js)
// ─────────────────────────────────────────────────────────────────────────────────────────
export const attendanceService = {
  async getEmployeeAttendanceSummary(o: { date: string; department?: string | null }) {
    const today = tzDate();
    // Only the fields the attendance engine reads — never salary, documents or photos.
    let eq = db().from("hr_employees")
      .select("id,full_name,portal_email,division,employment_status,account_type,employment_type,joining_date,probation_months,notice_active,notice_start,notice_end,work_schedule_type,expected_start_time,expected_end_time,work_days,grace_minutes");
    if (o.department) eq = eq.eq("division", o.department);
    const { data: emps, error } = await eq;
    if (error) throw new Error(error.message);
    const active = (emps || []).filter((e: Row) => !["system", "management"].includes(e.account_type) && !["inactive", "exited"].includes(lc(e.employment_status || "active")));
    if (!active.length) return { date: o.date, department: o.department || "all", employees: 0, totals: {}, by_department: {}, people: {} };
    const ids = active.map((e: Row) => e.id);
    const [reqs, att, hol, set, oe, logs] = await Promise.all([
      fetchAll("hr_leave_requests", "*", (q) => q.in("employee_id", ids).lte("start_date", o.date).gte("end_date", o.date)),
      fetchAll("hr_attendance", "*", (q) => q.in("employee_id", ids).eq("att_date", o.date)),
      db().from("hr_holidays").select("*"),
      db().from("hr_company_settings").select("*").maybeSingle(),
      db().from("hr_official_events").select("*"),
      db().from("attendance_logs").select("employee_email,log_in_time,log_out_time").eq("log_date", o.date),
    ]);
    const logged = new Set((logs.data || []).map((l: Row) => lc(l.employee_email)));
    const now = o.date < today ? new Date(o.date + "T23:59:00Z") : wallNow();
    const T = { present: 0, late: 0, wfh: 0, half_day: 0, approved_leave: 0, leave_lop: 0, unapproved_absence: 0, not_clocked_in_yet: 0, weekly_off_or_holiday: 0, not_scheduled: 0, missing_clock_out: 0 };
    const people: Record<string, string[]> = { approved_leave: [], leave_lop: [], unapproved_absence: [], missing_clock_out: [], not_clocked_in_yet: [], wfh: [], half_day: [], late: [] };
    const byDept: Record<string, Record<string, number>> = {};
    for (const e of active) {
      const myAtt = att.filter((a) => a.employee_id === e.id).map((a) => ({ ...a, clock_in_time: toWallClock(a.clock_in_time), clock_out_time: toWallClock(a.clock_out_time) }));
      const ctx = {
        employee: e, requests: reqs.filter((r) => r.employee_id === e.id), attendance: myAtt,
        holidays: hol.data || [], settings: set.data || {}, clBuckets: [], slLedger: [],
        officialEvents: (oe.data || []).filter((x: Row) => !x.applies_to || x.applies_to === "all" || x.applies_to === e.division),
        portalLog: (d: string) => d === o.date && logged.has(lc(e.portal_email)),
        now, date: o.date,
      };
      let r: Row;
      try { r = LP.resolveAttendanceStatus(ctx, o.date); } catch (_) { continue; }
      let k: keyof typeof T;
      if (r.preJoining || r.code === "NS") k = "not_scheduled";
      else if (r.open) k = "not_clocked_in_yet";
      else if (r.code === "P") k = "present";
      else if (r.code === "L") k = "late";
      else if (r.code === "WFH") k = "wfh";
      else if (r.code === "HD") k = "half_day";
      else if (["SL", "CL", "ML"].includes(r.code)) k = "approved_leave";
      else if (["WO", "H", "OE"].includes(r.code)) k = "weekly_off_or_holiday";
      else if (r.unapproved) k = "unapproved_absence";
      else k = "leave_lop";
      T[k]++;
      const dept = e.division || "other";
      (byDept[dept] ||= {})[k] = (byDept[dept][k] || 0) + 1;
      if (people[k]) people[k].push(e.full_name);
      const row = att.find((a) => a.employee_id === e.id);
      if (row && row.clock_in_time && !row.clock_out_time && (o.date < today)) { T.missing_clock_out++; people.missing_clock_out.push(e.full_name); }
    }
    return {
      date: o.date, department: o.department || "all", employees: active.length,
      totals: { ...T, present_including_late: T.present + T.late },
      by_department: byDept,
      people,
      notes: "present = clocked in on time; late counted separately; LOP = leave resolved unpaid by policy; unapproved_absence = scheduled day, no clock-in and no approved leave; missing_clock_out only checked for past days.",
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Sales + CRM
// ─────────────────────────────────────────────────────────────────────────────────────────
async function salesRoster(): Promise<Row[]> {
  const { data, error } = await db().from("hr_employees").select("id,full_name,employment_status,designation").eq("division", "sales");
  if (error) throw new Error(error.message);
  return (data || []).filter((e: Row) => !["inactive", "exited"].includes(lc(e.employment_status)));
}

export const salesService = {
  async getSalesSummary(range: DateRange) {
    const [roster, leads, crm] = await Promise.all([
      salesRoster(),
      fetchAll("leads", "id,stage,temperature,assigned_to,created_at,updated_at,first_contact_at,source"),
      fetchAll("students", "id,name,enrolled_date,counsellor_id,source_counsellor,programme", (q) => q.eq("crm_source", "xale")),
    ]);
    const inR = (d: string) => d >= range.from && d <= range.to;
    const newLeads = leads.filter((l) => inR(tsDay(l.created_at)));
    const leadConv = leads.filter((l) => l.stage === "Enrolled" && inR(tsDay(l.updated_at)));
    const crmEnr = crm.filter((s) => s.enrolled_date && inR(String(s.enrolled_date).slice(0, 10)));
    const enrollments = leadConv.length + crmEnr.length;
    const denom = newLeads.length + crmEnr.length;
    const byStage: Record<string, number> = {};
    newLeads.forEach((l) => { byStage[l.stage || "Unknown"] = (byStage[l.stage || "Unknown"] || 0) + 1; });
    const counselors = roster.map((c) => {
      const own = newLeads.filter((l) => String(l.assigned_to) === String(c.id));
      const conv = leadConv.filter((l) => String(l.assigned_to) === String(c.id)).length;
      const crmN = crmEnr.filter((s) => String(s.counsellor_id) === String(c.id) || (!s.counsellor_id && lc(s.source_counsellor) === lc(c.full_name))).length;
      return { counselor: c.full_name, new_leads: own.length, enrollments: conv + crmN, lead_conversions: conv, crm_enrollments: crmN };
    }).sort((a, b) => b.enrollments - a.enrollments || b.new_leads - a.new_leads);
    return {
      range, leads: newLeads.length, leads_by_stage: byStage, conversions: leadConv.length,
      crm_enrollments: crmEnr.length, enrollments,
      conversion_rate_percent: denom ? Math.round((enrollments / denom) * 100) : 0,
      need_first_contact: leads.filter((l) => !l.first_contact_at && l.stage === "New").length,
      counselor_performance: counselors,
      notes: "Enrollments = leads moved to Enrolled in the range + Xale CRM enrolments in the range (Sales dashboard rule). Conversion rate = enrollments ÷ (new leads + CRM enrolments).",
    };
  },

  async getTopCounselor(timeframeDays: number, metric: "lead_conversion" | "sales_volume") {
    const range: DateRange = { from: addDays(tzDate(), -(timeframeDays - 1)), to: tzDate(), label: `last ${timeframeDays} days` };
    const s = await salesService.getSalesSummary(range);
    if (metric === "lead_conversion") {
      const ranked = s.counselor_performance.map((c) => ({ ...c, conversion_rate_percent: c.new_leads + c.crm_enrollments ? Math.round(c.enrollments / (c.new_leads + c.crm_enrollments) * 100) : 0 }));
      return { range, metric, top: ranked[0]?.enrollments ? ranked[0] : null, ranking: ranked };
    }
    // sales_volume — net course fee (fee − discount) of students enrolled in the window, by counsellor.
    const [roster, crm, leads] = await Promise.all([
      salesRoster(),
      fetchAll("students", "id,uin,enrolled_date,counsellor_id,source_counsellor", (q) => q.gte("enrolled_date", range.from).lte("enrolled_date", range.to)),
      fetchAll("leads", "assigned_to,student_uin,stage,updated_at", (q) => q.eq("stage", "Enrolled")),
    ]);
    const owner: Record<string, string> = {};
    for (const st of crm) {
      if (st.counsellor_id) owner[st.id] = st.counsellor_id;
      else { const l = leads.find((x) => x.student_uin && x.student_uin === st.uin); if (l?.assigned_to) owner[st.id] = l.assigned_to; else if (st.source_counsellor) { const c = roster.find((r) => lc(r.full_name) === lc(st.source_counsellor)); if (c) owner[st.id] = c.id; } }
    }
    const ids = Object.keys(owner);
    const pay = ids.length ? await fetchAll("payments", "student_id,course_fee,discount", (q) => q.in("student_id", ids)) : [];
    const vol: Record<string, { revenue: number; students: number }> = {};
    for (const id of ids) {
      const p = pay.find((x) => x.student_id === id);
      const net = p ? Math.max(0, Number(p.course_fee || 0) - Number(p.discount || 0)) : 0;
      const k = owner[id]; vol[k] ||= { revenue: 0, students: 0 }; vol[k].revenue += net; vol[k].students++;
    }
    const ranking = roster.map((c) => ({ counselor: c.full_name, net_course_fee_inr: Math.round(vol[c.id]?.revenue || 0), enrolled_students: vol[c.id]?.students || 0 }))
      .sort((a, b) => b.net_course_fee_inr - a.net_course_fee_inr || b.enrolled_students - a.enrolled_students);
    return { range, metric, top: ranking[0]?.enrolled_students ? ranking[0] : null, ranking, notes: "Net course fee = payments.course_fee − discount for students enrolled in the window." };
  },
};

export const crmService = {
  async queryLeads(status: string, limit: number) {
    const st = lc(status);
    let q = db().from("leads").select("lead_id,name,stage,temperature,course_interest,source,assigned_to,created_at,next_action_date,first_contact_at").order("created_at", { ascending: false });
    if (st === "need_contact" || st === "need_first_contact") q = q.eq("stage", "New").is("first_contact_at", null);
    else if (st === "hot" || st === "warm" || st === "cold") q = q.ilike("temperature", st);
    else if (st && st !== "all" && st !== "any") q = q.ilike("stage", status.trim());
    const { data, error } = await q.limit(limit);
    if (error) throw new Error(error.message);
    const roster = await salesRoster();
    const name: Record<string, string> = {}; roster.forEach((r) => { name[r.id] = r.full_name; });
    const { count } = await (st === "all" || st === "any" || !st ? db().from("leads").select("id", { count: "exact", head: true }) : Promise.resolve({ count: null }));
    return {
      filter: status, total_matching: count ?? (data || []).length, returned: (data || []).length,
      leads: (data || []).map((l: Row) => ({ lead_id: l.lead_id, name: l.name, stage: l.stage, temperature: l.temperature, course_interest: l.course_interest,
        source: l.source, counselor: name[l.assigned_to] || "Unassigned", created: tsDay(l.created_at), next_action: l.next_action_date })),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Cross-department metrics (manager.html overview rules)
// ─────────────────────────────────────────────────────────────────────────────────────────
export const metricsService = {
  async academic(range: DateRange) {
    const today = tzDate();
    const [classes, stu, tr, up] = await Promise.all([
      academicService.getClasses({ from: range.from, to: range.to }),
      fetchAll("students", "status,batch_id"),
      db().from("trainers").select("id", { count: "exact", head: true }).eq("status", "active"),
      academicService.getUpcomingBatches(30),
    ]);
    const bq = await db().from("batches").select("id,status,expected_completion_date,deleted_at").eq("status", "active").is("deleted_at", null);
    const activeBatches = (bq.data || []).filter((b: Row) => !b.expected_completion_date || b.expected_completion_date >= today).length;
    return {
      active_batches: activeBatches, active_trainers: tr.count ?? 0, students_total: stu.length,
      students_without_batch: stu.filter((s) => !s.batch_id && !["Dropped", "Completed"].includes(s.status)).length,
      classes_in_range: classes.length, classes_attendance_not_marked: classes.filter((c) => c.attendance === "not_marked" && c.status !== "in_progress").length,
      upcoming_batches_next_30_days: up.length,
    };
  },
  async hr(range: DateRange) {
    const day = range.to >= tzDate() && range.from <= tzDate() ? tzDate() : range.to;
    const [sum, pend] = await Promise.all([
      attendanceService.getEmployeeAttendanceSummary({ date: day }),
      db().from("hr_leave_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    return { attendance_date: day, employees: sum.employees, attendance: sum.totals, leave_requests_pending: pend.count ?? 0 };
  },
  async media(range: DateRange) {
    const rows = await fetchAll("assignments", "status,type,scope,date,manager_approved,completed_at,submitted_at");
    const media = rows.filter((t) => t.scope !== "org");
    const open = ["Pending", "In Progress", "Rework Required"];
    const inR = (ts: string) => { const d = tsDay(ts); return d >= range.from && d <= range.to; };
    const today = tzDate();
    return {
      media_active_queue: media.filter((t) => t.status === "Pending" || t.status === "In Progress").length,
      media_rework: media.filter((t) => t.status === "Rework Required").length,
      media_awaiting_approval: media.filter((t) => t.status === "Completed" && t.manager_approved !== true).length,
      media_completed_in_range: media.filter((t) => t.status === "Completed" && inR(t.completed_at || t.submitted_at)).length,
      all_work_open: rows.filter((t) => open.includes(t.status || "Pending")).length,
      all_work_overdue: rows.filter((t) => open.includes(t.status || "Pending") && isIsoDate(String(t.date || "").slice(0, 10)) && String(t.date).slice(0, 10) < today).length,
    };
  },
};
