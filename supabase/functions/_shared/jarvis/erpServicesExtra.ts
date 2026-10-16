// Read-only ERP services added for the full-ERP Jarvis (2026-10-16). Same rules as the portals
// that own the data. No writes, no generic SQL, only the rows needed to answer, contacts never
// returned. Authorisation is enforced in erpTools.ts BEFORE any of these run; the `scope`
// arguments below narrow results further (own data only, own department only, …).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { adminClient } from "./auth.ts";
import { academicService, attendanceService, salesService } from "./erpServices.ts";
import { addDays, isIsoDate, tsDay, tzDate, type DateRange } from "./time.ts";
import "./vendor/leave-policy.js";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
const LP: any = (globalThis as any).LeavePolicy;
const db = (): SupabaseClient => adminClient();
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const like = (s: string) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

export const DIV_LABEL: Record<string, string> = {
  education: "Academics", production: "Media / Production", sales: "Sales", hr: "HR", accounts: "Accounts", management: "Management", other: "Administration",
};
const divName = (d: unknown) => DIV_LABEL[String(d || "")] || String(d || "—");
const OPEN = ["Pending", "In Progress", "Rework Required"];

// ── small metadata cache (safe, slow-changing data only — never live values) ──────────────
const _cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const c = _cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await load();
  _cache.set(key, { at: Date.now(), v });
  return v;
}
/** Employee directory (names / department / designation / status) — 2 min cache. */
export function employeeDirectory(): Promise<Row[]> {
  return cached("emps", 120_000, async () => {
    const { data, error } = await db().from("hr_employees")
      .select("id,full_name,portal_email,division,designation,employment_status,employment_type,account_type,joining_date,system_role");
    if (error) throw new Error(error.message);
    return (data || []).filter((e: Row) => e.account_type !== "system");
  });
}
function matchPeople(list: Row[], q: string, key = "full_name"): Row[] {
  const s = lc(q); if (!s) return [];
  const exact = list.filter((x) => lc(x[key]) === s);
  if (exact.length) return exact;
  const word = list.filter((x) => lc(x[key]).split(/\s+/).includes(s) || lc(x[key]).startsWith(s));
  return word.length ? word : list.filter((x) => lc(x[key]).includes(s));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// HR
// ─────────────────────────────────────────────────────────────────────────────────────────
export const hrExtra = {
  /** Every employee with approved (not cancelled) leave / WFH covering `date`. */
  async leaveOn(date: string, department?: string | null, person?: string | null) {
    const emps = (await employeeDirectory()).filter((e) => lc(e.employment_status || "active") === "active");
    const byId: Record<string, Row> = {}; emps.forEach((e) => { byId[e.id] = e; });
    const { data, error } = await db().from("hr_leave_requests")
      .select("employee_id,leave_type,start_date,end_date,days,half_day_type,status,manager_status,hr_status,final_treatment,cancelled_at,reason")
      .lte("start_date", date).gte("end_date", date);
    if (error) throw new Error(error.message);
    let rows = (data || []).filter((r: Row) => !r.cancelled_at && byId[r.employee_id] && LP.isApproved(r));
    if (department) rows = rows.filter((r: Row) => byId[r.employee_id].division === department);
    if (person) { const ids = new Set(matchPeople(emps, person).map((e) => e.id)); rows = rows.filter((r: Row) => ids.has(r.employee_id)); }
    const list = rows.map((r: Row) => {
      const e = byId[r.employee_id], wfh = /home|wfh/i.test(r.leave_type || "");
      return { name: e.full_name, department: divName(e.division), designation: e.designation || null,
        type: wfh ? "Work from home" : r.leave_type, half_day: r.half_day_type || null, from: r.start_date, to: r.end_date,
        days: r.days != null ? Number(r.days) : null, unpaid: lc(r.final_treatment).startsWith("lop") || undefined };
    });
    const pend = await db().from("hr_leave_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    const byDept: Record<string, number> = {}; list.forEach((x) => { byDept[x.department] = (byDept[x.department] || 0) + 1; });
    return { date, on_leave_or_wfh: list.length, on_leave: list.filter((x) => x.type !== "Work from home").length,
      work_from_home: list.filter((x) => x.type === "Work from home").length, by_department: byDept, people: list,
      leave_requests_waiting_for_approval: pend.count ?? 0 };
  },

  /** Holidays in a range, with department scope (all / listed departments). */
  async holidays(range: DateRange, myDivision?: string | null) {
    const { data, error } = await db().from("hr_holidays").select("*").gte("holiday_date", range.from).lte("holiday_date", range.to).order("holiday_date");
    if (error) throw new Error(error.message);
    return { range, holidays: (data || []).map((h: Row) => {
      const scoped = h.holiday_scope === "departments";
      return { date: h.holiday_date, name: h.name, type: h.type,
        applies_to: scoped ? (h.departments || []).map(divName).join(", ") || "no department" : "All departments",
        applies_to_you: myDivision ? (scoped ? (h.departments || []).includes(myDivision) : true) : undefined };
    }) };
  },

  /** Payroll for one employee and month (saved hr_payroll row — the payslip source). */
  async payroll(employeeId: string, month: string) {
    const e = (await employeeDirectory()).find((x) => x.id === employeeId);
    const [p, sal] = await Promise.all([
      db().from("hr_payroll").select("*").eq("employee_id", employeeId).eq("month", month).maybeSingle(),
      db().from("hr_employees").select("monthly_salary,salary_type,hourly_rate,employment_type").eq("id", employeeId).maybeSingle(),
    ]);
    if (p.error) throw new Error(p.error.message);
    const r = p.data as Row | null;
    if (!r) return { employee: e?.full_name, month, note: "No payroll has been generated for this month yet.", monthly_salary: sal.data?.monthly_salary ?? null };
    const bd = (r.day_breakdown || {}) as Row;
    return {
      employee: e?.full_name, department: divName(e?.division), month,
      monthly_salary: sal.data?.monthly_salary ?? null, salary_basis: "fixed monthly salary ÷ 30 per day (ERP rule)",
      basic: r.basic, allowances: r.allowances, overtime: r.overtime, bonuses: r.bonuses, incentive: r.incentive_amount,
      deductions: r.deductions, advances: r.advances, leave_deduction: r.leave_deduction, net_salary: r.net_salary,
      paid_leave_days: r.paid_leave_days, unpaid_leave_days: r.unpaid_leave_days, absent_days: r.absent_days,
      lop_days: bd.lop_days ?? null, present_days: bd.present ?? null, weekly_off_days: bd.weekly_off ?? null, holiday_days: bd.holiday ?? null,
      payment_status: r.payment_status, payslip_status: r.payslip_status, published: r.published,
    };
  },

  /** Company assets — whole register (filters) or one employee's current + past items. */
  async assets(o: { employeeId?: string | null; status?: string | null; query?: string | null }) {
    const [a, types, open] = await Promise.all([
      db().from("hr_assets").select("id,name,type_id,asset_code,brand,model,condition,status,current_employee_id,purchase_date"),
      db().from("hr_asset_types").select("id,name"),
      db().from("hr_asset_assignments").select("asset_id,employee_id,assigned_date,returned_date,end_reason"),
    ]);
    if (a.error) throw new Error(a.error.message);
    const tn: Record<string, string> = {}; (types.data || []).forEach((t: Row) => { tn[t.id] = t.name; });
    const emps = await employeeDirectory(); const en: Record<string, string> = {}; emps.forEach((e) => { en[e.id] = e.full_name; });
    const since: Record<string, string> = {}; (open.data || []).forEach((x: Row) => { if (!x.returned_date) since[x.asset_id] = x.assigned_date; });
    let rows = (a.data || []) as Row[];
    if (o.status) rows = rows.filter((x) => x.status === o.status);
    if (o.query) { const q = lc(o.query); rows = rows.filter((x) => [x.name, x.asset_code, x.brand, x.model, tn[x.type_id]].some((v) => lc(v).includes(q))); }
    const fmt = (x: Row) => ({ asset: x.name, type: tn[x.type_id] || null, asset_id: x.asset_code || null, status: x.status,
      condition: x.condition || null, assigned_to: x.current_employee_id ? en[x.current_employee_id] || "—" : null, assigned_since: since[x.id] || null });
    if (o.employeeId) {
      const mine = rows.filter((x) => x.current_employee_id === o.employeeId).map(fmt);
      const past = (open.data || []).filter((x: Row) => x.employee_id === o.employeeId && x.returned_date)
        .map((x: Row) => { const as = (a.data || []).find((y: Row) => y.id === x.asset_id); return { asset: as?.name, asset_id: as?.asset_code, held: `${x.assigned_date} → ${x.returned_date}`, ended: x.end_reason }; });
      return { employee: en[o.employeeId], current_assets: mine.length, assets: mine, previously_held: past.slice(0, 10) };
    }
    const c: Record<string, number> = {}; rows.forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; });
    return { total: rows.length, by_status: c, assets: rows.slice(0, 40).map(fmt), truncated: rows.length > 40 };
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Academic
// ─────────────────────────────────────────────────────────────────────────────────────────
async function sessionsDone(batchName: string): Promise<{ done: number; dates: string[] }> {
  const { data } = await db().from("attendance").select("session_date,session_num,status").eq("batch_name", batchName).eq("status", "present");
  const keys = new Set<string>(), dates = new Set<string>();
  (data || []).forEach((a: Row) => { if (a.session_date) { keys.add("d" + a.session_date); dates.add(String(a.session_date).slice(0, 10)); } else keys.add("n" + a.session_num); });
  return { done: keys.size, dates: [...dates].sort() };
}
export const academicExtra = {
  async batchDetails(name: string, trainerId?: string | null) {
    let q = db().from("batches").select("*").is("deleted_at", null).ilike("name", like(name)).limit(5);
    if (trainerId) q = q.eq("trainer_id", trainerId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const list = (data || []) as Row[];
    if (!list.length) return { note: `No batch matching "${name}"${trainerId ? " among your batches" : ""}.` };
    if (list.length > 1 && !list.some((b) => lc(b.name) === lc(name))) return { note: "Several batches match — ask which one.", matches: list.map((b) => b.name) };
    const b = list.find((x) => lc(x.name) === lc(name)) || list[0];
    const [st, tr, prog] = await Promise.all([
      db().from("students").select("name,status").eq("batch_id", b.id),
      b.trainer_id ? db().from("trainers").select("name").eq("id", b.trainer_id).maybeSingle() : Promise.resolve({ data: null }),
      sessionsDone(b.name),
    ]);
    const total = Number(b.sessions_total) || null, done = prog.done + (Number(b.baseline_sessions) || 0);
    const students = (st.data || []).filter((s: Row) => s.status !== "Dropped");
    return {
      batch: b.name, course: b.programme, trainer: (tr.data as Row | null)?.name || b.trainer_name || "Unassigned", status: b.status,
      frozen: b.status === "frozen" ? { from: b.freeze_start_date, resume: b.freeze_resume_date, reason: b.freeze_reason } : undefined,
      days: b.day_pattern, time: b.time_slot, class_minutes: b.class_duration_minutes, start_date: b.start_date,
      planned_end: b.expected_completion_date, sessions_done: done, sessions_total: total,
      sessions_left: total ? Math.max(0, total - done) : null, last_class_marked: prog.dates.slice(-1)[0] || null,
      students: students.length, capacity: b.capacity, student_names: students.slice(0, 30).map((s: Row) => s.name),
      group_classes_completed: b.group_classes_completed_at ? String(b.group_classes_completed_at).slice(0, 10) : undefined,
    };
  },

  async studentInfo(name: string, trainerName?: string | null) {
    const { data, error } = await db().from("students").select("id,uin,name,batch_id,batch_name,trainer_name,programme,status,enrolled_date,planned_end_date,source_counsellor,dropped_at,drop_reason").ilike("name", like(name)).limit(6);
    if (error) throw new Error(error.message);
    let list = (data || []) as Row[];
    if (trainerName) list = list.filter((s) => lc(s.trainer_name) === lc(trainerName));
    if (!list.length) return { note: `No student matching "${name}"${trainerName ? " in your batches" : ""}.` };
    const out = await Promise.all(list.slice(0, 3).map(async (s) => {
      const att = s.batch_name ? await db().from("attendance").select("status,session_date").eq("batch_name", s.batch_name).eq("student_uin", s.uin) : { data: [] };
      const rows = (att.data || []) as Row[];
      const present = rows.filter((a) => a.status === "present").length;
      return { student: s.name, uin: s.uin, batch: s.batch_name || "No batch yet", trainer: s.trainer_name || null, course: s.programme, status: s.status,
        enrolled: s.enrolled_date, planned_end: s.planned_end_date, counsellor: s.source_counsellor || null,
        sessions_marked: rows.length, present, absent: rows.filter((a) => a.status === "absent").length,
        attendance_percent: rows.length ? Math.round(present / rows.length * 100) : null,
        last_attended: rows.filter((a) => a.status === "present").map((a) => String(a.session_date || "")).sort().slice(-1)[0] || null,
        dropped: s.dropped_at ? { on: String(s.dropped_at).slice(0, 10), reason: s.drop_reason } : undefined };
    }));
    return { matches: list.length, students: out };
  },

  /** Google Meet / Live Classes status for a day. */
  async liveClasses(date: string, trainerId?: string | null) {
    let q = db().from("academic_live_classes").select("occurrence_key,batch_id,trainer_id,class_date,start_time,end_time,class_status,live_status,google_meet_url,google_sync_status,meet_status,actual_duration_minutes,attendance_review_status").eq("class_date", date);
    if (trainerId) q = q.eq("trainer_id", trainerId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data || []) as Row[];
    const bIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))];
    const bn: Record<string, string> = {};
    if (bIds.length) ((await db().from("batches").select("id,name").in("id", bIds)).data || []).forEach((b: Row) => { bn[b.id] = b.name; });
    const c = (f: (r: Row) => boolean) => rows.filter(f).length;
    return { date, live_classes_linked: rows.length, with_meet_link: c((r) => !!r.google_meet_url), cancelled: c((r) => r.class_status === "cancelled"),
      live_now: c((r) => r.live_status === "live"), ended: c((r) => r.live_status === "ended"), sync_errors: c((r) => /error|failed/i.test(r.google_sync_status || "")),
      classes: rows.slice(0, 30).map((r) => ({ batch: bn[r.batch_id] || r.occurrence_key, start: r.start_time, status: r.class_status, live: r.live_status || "scheduled",
        meet_link: r.google_meet_url ? "created" : "missing", duration_minutes: r.actual_duration_minutes ?? undefined })) };
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Work (central Work Assignment — assignments table; Media / Production queue included)
// ─────────────────────────────────────────────────────────────────────────────────────────
export const workExtra = {
  async tasks(o: { status: string; department?: string | null; range?: DateRange | null; employee?: string | null; onlyDepartment?: string | null }) {
    const { data, error } = await db().from("assignments")
      .select("id,topic,type,status,priority,date,assigned_to,assigned_by,department,scope,completed_at,submitted_at,manager_approved,asset_link,assignment_type,created_at");
    if (error) throw new Error(error.message);
    const today = tzDate();
    let rows = ((data || []) as Row[]).filter((t) => t.status !== "cancelled");
    const dep = o.onlyDepartment || o.department;
    if (dep) rows = rows.filter((t) => (t.department || (t.scope === "org" ? "management" : "production")) === dep);
    if (o.employee) rows = rows.filter((t) => lc(t.assigned_to).includes(lc(o.employee)));
    const isOpen = (t: Row) => OPEN.includes(t.status || "Pending");
    const overdue = (t: Row) => isOpen(t) && isIsoDate(String(t.date || "").slice(0, 10)) && String(t.date).slice(0, 10) < today;
    const doneIn = (t: Row) => { if (t.status !== "Completed") return false; if (!o.range) return true; const d = tsDay(t.completed_at || t.submitted_at); return d >= o.range.from && d <= o.range.to; };
    const st = lc(o.status);
    const pick = rows.filter((t) => st === "open" ? isOpen(t) : st === "overdue" ? overdue(t) : st === "completed" ? doneIn(t)
      : st === "rework" ? t.status === "Rework Required" : st === "awaiting_review" ? t.status === "Completed" && t.manager_approved !== true
      : st === "in_progress" ? t.status === "In Progress" : true);
    const byPerson: Record<string, number> = {}; pick.forEach((t) => { byPerson[t.assigned_to || "Unassigned"] = (byPerson[t.assigned_to || "Unassigned"] || 0) + 1; });
    return {
      filter: st, department: dep ? divName(dep) : "all departments", range: o.range || undefined,
      counts: { open: rows.filter(isOpen).length, in_progress: rows.filter((t) => t.status === "In Progress").length, overdue: rows.filter(overdue).length,
        rework: rows.filter((t) => t.status === "Rework Required").length, awaiting_review: rows.filter((t) => t.status === "Completed" && t.manager_approved !== true).length,
        completed_in_range: rows.filter(doneIn).length },
      matching: pick.length, by_person: byPerson,
      tasks: pick.sort((a, b) => String(b.completed_at || b.date || "").localeCompare(String(a.completed_at || a.date || ""))).slice(0, 20).map((t) => ({
        task: t.topic, type: t.type, employee: t.assigned_to, department: divName(t.department || (t.scope === "org" ? "management" : "production")),
        status: t.status, priority: t.priority || null, due: t.date ? String(t.date).slice(0, 10) : null, overdue: overdue(t) || undefined,
        completed: t.completed_at || t.submitted_at ? tsDay(t.completed_at || t.submitted_at) : undefined,
        output_uploaded: t.status === "Completed" ? !!String(t.asset_link || "").trim() : undefined, assigned_by: t.assigned_by })),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Common: notifications, announcements, universal search
// ─────────────────────────────────────────────────────────────────────────────────────────
export const commonExtra = {
  async myNotifications(email: string) {
    const { data, error } = await db().from("erp_notifications").select("type,title,message,created_at,read_at,resolved_at")
      .eq("recipient_email", lc(email)).order("created_at", { ascending: false }).limit(25);
    if (error) return { note: "Notifications are not available yet." };
    const rows = (data || []) as Row[];
    const unread = rows.filter((n) => !n.read_at && !n.resolved_at);
    return { unread: unread.length, notifications: (unread.length ? unread : rows.slice(0, 8)).slice(0, 12).map((n) => ({ type: n.type, title: n.title, message: n.message, at: n.created_at, unread: !n.read_at && !n.resolved_at })) };
  },
  async announcements(employeeId: string, division: string | null, limit: number) {
    const { data, error } = await db().from("hr_announcements").select("id,title,message,category,priority,created_at,start_at,end_at,audience,audience_departments,audience_employee_ids,archived_at,pinned")
      .is("archived_at", null).order("created_at", { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const now = new Date().toISOString();
    const mine = ((data || []) as Row[]).filter((a) => (!a.start_at || a.start_at <= now) && (!a.end_at || a.end_at >= now)
      && (!a.audience || a.audience === "all" || (a.audience_departments || []).includes(division) || (a.audience_employee_ids || []).map(String).includes(String(employeeId))));
    return { count: mine.length, announcements: mine.slice(0, limit).map((a) => ({ title: a.title, message: String(a.message || "").slice(0, 400), priority: a.priority, category: a.category, posted: tsDay(a.created_at), pinned: a.pinned || undefined })) };
  },
  /** One query routed to the modules this person may read. Never returns contacts. */
  async search(q: string, modules: string[], scope: { trainerName?: string | null; salesOwnId?: string | null }) {
    const out: Row = { query: q };
    const jobs: Promise<void>[] = [];
    const s = like(q);
    if (modules.includes("people")) jobs.push(employeeDirectory().then((e) => { out.employees = matchPeople(e, q).slice(0, 8).map((x) => ({ name: x.full_name, department: divName(x.division), designation: x.designation, status: x.employment_status || "active" })); }));
    if (modules.includes("academic")) {
      jobs.push((async () => { let qq = db().from("batches").select("name,programme,status,trainer_name,time_slot,day_pattern").is("deleted_at", null).ilike("name", s).limit(8); if (scope.trainerName) qq = qq.eq("trainer_name", scope.trainerName); out.batches = (await qq).data || []; })());
      jobs.push((async () => { let qq = db().from("students").select("name,batch_name,trainer_name,programme,status").ilike("name", s).limit(8); if (scope.trainerName) qq = qq.eq("trainer_name", scope.trainerName); out.students = (await qq).data || []; })());
      jobs.push((async () => { out.courses = (await db().from("courses").select("name,type,sessions_total,fee,active").ilike("name", s).limit(5)).data || []; })());
    }
    if (modules.includes("sales")) jobs.push((async () => { let qq = db().from("leads").select("name,stage,temperature,course_interest,created_at").ilike("name", s).order("created_at", { ascending: false }).limit(8); if (scope.salesOwnId) qq = qq.eq("assigned_to", scope.salesOwnId); out.leads = (await qq).data || []; })());
    if (modules.includes("work")) jobs.push((async () => { out.work_tasks = ((await db().from("assignments").select("topic,status,assigned_to,department,date").ilike("topic", s).neq("status", "cancelled").limit(8)).data || []); })());
    if (modules.includes("assets")) jobs.push((async () => { out.assets = ((await db().from("hr_assets").select("name,asset_code,status,condition").or(`name.ilike.${s},asset_code.ilike.${s}`).limit(8)).data || []); })());
    await Promise.allSettled(jobs);
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Company status — ONE tool, sections fetched IN PARALLEL, only what this person may see.
// ─────────────────────────────────────────────────────────────────────────────────────────
export async function companyStatus(date: string, allow: { hr: boolean; academic: boolean; sales: boolean; work: boolean }) {
  const range: DateRange = { from: date, to: date, label: date === tzDate() ? "today" : date };
  const out: Row = { date, label: range.label };
  const jobs: Record<string, () => Promise<unknown>> = {};
  if (allow.hr) {
    jobs.attendance = async () => { const s = await attendanceService.getEmployeeAttendanceSummary({ date }); return { employees: s.employees, totals: s.totals }; };
    jobs.leave = async () => { const l = await hrExtra.leaveOn(date); return { on_leave: l.on_leave, work_from_home: l.work_from_home, by_department: l.by_department, names: l.people.slice(0, 10).map((p) => `${p.name} (${p.department})`), requests_waiting: l.leave_requests_waiting_for_approval }; };
  }
  if (allow.academic) {
    jobs.classes = async () => {
      const cls = await academicService.getClasses({ from: date, to: date });
      const notMarked = cls.filter((c) => c.attendance === "not_marked");
      return { total: cls.length, group: cls.filter((c) => c.class_type === "Group").length, one_to_one: cls.filter((c) => c.class_type !== "Group").length,
        attendance_marked: cls.filter((c) => c.attendance === "marked").length, attendance_pending: notMarked.length,
        pending_examples: notMarked.slice(0, 5).map((c) => `${c.start} ${c.batch} (${c.trainer})`) };
    };
  }
  if (allow.sales) jobs.sales = async () => { const s = await salesService.getSalesSummary(range); return { leads: s.leads, enrollments: s.enrollments, conversion_rate_percent: s.conversion_rate_percent, need_first_contact: s.need_first_contact }; };
  if (allow.work) jobs.work = async () => { const w = await workExtra.tasks({ status: "completed", range }); return { completed_today: w.counts.completed_in_range, open: w.counts.open, overdue: w.counts.overdue, awaiting_review: w.counts.awaiting_review, rework: w.counts.rework, completed_examples: w.tasks.slice(0, 5).map((t) => `${t.task} — ${t.employee}`) }; };
  const keys = Object.keys(jobs);
  const res = await Promise.allSettled(keys.map((k) => jobs[k]()));
  keys.forEach((k, i) => { const r = res[i]; out[k] = r.status === "fulfilled" ? r.value : { error: "could not be read right now" }; });
  out.sections_not_permitted = [!allow.hr && "HR", !allow.academic && "Academics", !allow.sales && "Sales", !allow.work && "Work"].filter(Boolean);
  return out;
}

export { addDays };
