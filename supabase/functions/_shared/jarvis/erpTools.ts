// Jarvis ERP tools — the ONLY way the LLM can touch company data.
//   • read-only: every tool maps to a fixed service read in erpServices.ts (no SQL, no writes)
//   • arguments validated with Zod before anything runs
//   • authorised per tool against the server-resolved JarvisAuthContext
//   • results are compact JSON (only the rows needed to answer), capped in size
import { z } from "npm:zod@4.6.5";
import { can, type JarvisAuthContext } from "./auth.ts";
import { config } from "./config.ts";
import { academicService, attendanceService, crmService, leaveService, metricsService, salesService, selfService } from "./erpServices.ts";
import { academicExtra, commonExtra, companyStatus, employeeDirectory, hrExtra, workExtra } from "./erpServicesExtra.ts";
import { searchKnowledge } from "./knowledge.ts";
import { addDays, resolveDateRange, tzDate } from "./time.ts";

/** Vendor-neutral tool definition (converted per LLM provider). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const datePhrase = z.string().max(40)
  .describe("Date or range: today | tomorrow | yesterday | this_week | last_week | this_month | last_month | last_7_days | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD. Resolved in Asia/Kolkata.");

const SCHEMAS = {
  get_todays_classes: z.object({
    date: datePhrase.optional().describe("Day to list classes for (default today). A short range (max 7 days) is allowed, e.g. tomorrow or this_week."),
    trainer_id: z.string().max(64).optional().describe("Trainer UUID, if known."),
    trainer_name: z.string().max(80).optional().describe("Trainer/coach name as spoken (English spelling), e.g. Namratha. Use this to filter one trainer."),
    include_group: z.boolean().optional().describe("Include group batch classes (default true)."),
    include_one_to_one: z.boolean().optional().describe("Include 1:1 classes and group-linked 1:1 sessions (default true)."),
  }),
  get_trainers_on_leave: z.object({
    date: datePhrase.optional().describe("Day to check (default today)."),
  }),
  get_unmarked_class_attendance: z.object({
    date: datePhrase.optional().describe("Day to check (default today)."),
    trainer_id: z.string().max(64).optional(),
    trainer_name: z.string().max(80).optional(),
  }),
  get_employee_attendance_summary: z.object({
    date: datePhrase.optional().describe("Day (default today)."),
    department: z.enum(["production", "education", "sales", "hr", "accounts", "other"]).optional()
      .describe("HR division: production (Media), education (Academic), sales, hr, accounts, other. Omit for all."),
  }),
  get_upcoming_batches: z.object({
    department: z.literal("academic").optional(),
    days_ahead: z.number().int().min(1).max(180).optional().describe("Look-ahead window in days (default 30)."),
  }),
  get_sales_summary: z.object({
    date_range: datePhrase.describe("Period, e.g. this_week, this_month, last_30_days."),
  }),
  get_top_performing_counselor: z.object({
    timeframe_days: z.number().int().min(1).max(366).describe("Look-back window in days, e.g. 30 for this month so far, 7 for this week."),
    metric: z.enum(["lead_conversion", "sales_volume"]).describe("lead_conversion = enrollments/conversions; sales_volume = net course fee of enrolled students."),
  }),
  query_crm_leads: z.object({
    status: z.string().max(40).describe("Lead stage (e.g. New, Contacted, Assessment Booked, Ready to Pay, Enrolled), or hot | warm | cold | need_contact | all."),
    limit: z.number().int().min(1).max(25).describe("Max leads to return (keep small for voice, e.g. 5)."),
  }),
  get_erp_metrics: z.object({
    department: z.enum(["academic", "sales", "hr", "media", "all"]),
    date_range: datePhrase.describe("Period for the metrics, e.g. today, this_week, this_month."),
  }),
  get_my_tasks: z.object({
    status: z.enum(["open", "overdue", "completed", "rework required", "all"]).optional().describe("Which of MY work tasks (default open)."),
  }),
  get_my_attendance_and_leave: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM for the monthly summary (default this month)."),
  }),
  get_company_status: z.object({
    date: datePhrase.optional().describe("Day (default today)."),
  }),
  get_leave_status: z.object({
    date: datePhrase.optional().describe("Day (default today)."),
    department: z.enum(["production", "education", "sales", "hr", "accounts", "management", "other"]).optional(),
    person: z.string().max(80).optional().describe("One employee's name, to check only them."),
  }),
  get_holidays: z.object({
    date_range: datePhrase.optional().describe("Period (default this_month). Use next_30_days for upcoming."),
  }),
  get_work_tasks: z.object({
    status: z.enum(["open", "in_progress", "overdue", "completed", "rework", "awaiting_review", "all"]).describe("completed = finished in date_range; awaiting_review = completed but not yet approved."),
    department: z.enum(["production", "education", "sales", "hr", "accounts", "management", "other"]).optional().describe("production = Media / Production work."),
    date_range: datePhrase.optional().describe("For completed work (default today)."),
    employee_name: z.string().max(80).optional(),
  }),
  get_batch_details: z.object({
    batch_name: z.string().min(2).max(80).describe("Batch name as spoken, e.g. Talk Titans 01."),
  }),
  get_student_info: z.object({
    student_name: z.string().min(2).max(80),
  }),
  get_live_class_status: z.object({
    date: datePhrase.optional().describe("Day (default today)."),
  }),
  get_payroll_summary: z.object({
    employee_name: z.string().max(80).optional().describe("Omit for the speaker's OWN payroll."),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM (default last month if this month is not generated yet)."),
  }),
  get_company_assets: z.object({
    employee_name: z.string().max(80).optional().describe("Whose assets; omit with mine=true for the speaker's own."),
    mine: z.boolean().optional(),
    status: z.enum(["available", "assigned", "returned", "repair", "retired"]).optional(),
    query: z.string().max(60).optional().describe("Asset name / ID / type text, e.g. MacBook or BE-LAP-012."),
  }),
  get_my_notifications: z.object({}),
  get_announcements: z.object({
    limit: z.number().int().min(1).max(10).optional(),
  }),
  search_erp: z.object({
    query: z.string().min(2).max(80).describe("Name or words to look for (person, batch, student, course, lead, task, asset)."),
    module: z.enum(["people", "academic", "sales", "work", "assets", "any"]).optional().describe("Narrow the search (default any)."),
  }),
  get_erp_knowledge: z.object({
    question: z.string().min(3).max(300).describe("The how-does-it-work question, e.g. how is LOP calculated."),
    module: z.enum(["academics", "hr", "sales", "media", "management", "common"]).optional(),
  }),
} as const;

export type ToolName = keyof typeof SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  get_todays_classes: "List Academic classes (group, 1:1 and group-linked 1:1) for a day: time, trainer, batch, course, class type, student/group, status and attendance state, plus a count per trainer. Use for any question about who has classes / how many classes. Leadership gets ALL classes unless a trainer is named.",
  get_trainers_on_leave: "Trainers/coaches with APPROVED leave (or approved WFH) covering a day, with leave type and the classes they have that day.",
  get_unmarked_class_attendance: "Classes whose scheduled time has finished but attendance has not been submitted, with trainer, batch, class time and students.",
  get_employee_attendance_summary: "Company employee attendance for a day from the HR attendance engine: present, late, WFH, half day, approved leave, LOP, unapproved absence, not clocked in yet, missing clock-out, with department breakdown and names.",
  get_upcoming_batches: "Academic batches starting soon (status upcoming, or active with a future start date) with course, trainer, start date, schedule and enrolled count.",
  get_sales_summary: "Sales performance for a period: new leads, conversions, CRM enrollments, total enrollments, conversion rate and counselor performance.",
  get_top_performing_counselor: "Rank Sales counselors over the last N days by enrollments (lead_conversion) or by net course fee (sales_volume).",
  query_crm_leads: "List CRM leads by stage or temperature (name, stage, temperature, course interest, counselor, dates). Contact numbers are never returned.",
  get_erp_metrics: "Headline KPIs for a department (academic, sales, hr, media) or all, for a period — only the departments this person may see.",
  get_my_tasks: "The speaker's OWN assigned work tasks (Work Assignment): open, overdue, rework, completed, with due dates and who assigned them.",
  get_my_attendance_and_leave: "The speaker's OWN attendance today, this month's summary (present, late, leave, LOP), leave balances and recent leave requests.",
  get_company_status: "One-call organisation snapshot for a day, fetched in parallel: employee attendance, who is on leave, Academic classes and pending class attendance, Sales leads and enrollments, Work completed / open / overdue / awaiting review. Use for 'how is the company doing', 'today's status', 'give me a summary'. Only sections the speaker may see are included.",
  get_leave_status: "Every employee (all departments) on APPROVED leave or work-from-home on a day, with department, leave type, half day and dates, plus a per-department count and how many leave requests await approval. Use for 'who is on leave', 'is X on leave', 'which department are they from'.",
  get_holidays: "Company holidays in a period, with type and which departments they apply to (department-specific holidays only apply to the listed departments) and whether they apply to the speaker.",
  get_work_tasks: "Work Assignment tasks across departments (Media / Production videos, posters, thumbnails and all other assigned work): counts of open, in progress, overdue, rework, awaiting review, completed in a period, per-person counts and the task list with employee, status, due date and whether output was uploaded.",
  get_batch_details: "One Academic batch: course, trainer, status (frozen and why), schedule, start / planned end, sessions done / total / left, last class marked, students and capacity. Use to explain why a batch's class is or isn't happening.",
  get_student_info: "One student: batch, trainer, course, status, enrollment date, counsellor and attendance (sessions marked, present, absent, percentage, last attended). Contact details are never returned.",
  get_live_class_status: "Google Meet / Live Classes for a day: how many classes have a Meet link, live now, ended, cancelled, sync errors, per class.",
  get_payroll_summary: "Saved payroll for one employee and month: monthly salary, basic, allowances, incentive, deductions, leave deduction, LOP days, paid / unpaid leave days, absent days, net salary, payment and payslip status. Use to explain why someone's salary is lower. Without employee_name it returns the speaker's own payroll.",
  get_company_assets: "Company assets register: by employee (current assets and previously held), by status, or by name / asset ID, with type, condition and who holds it.",
  get_my_notifications: "The speaker's own Notification Center: unread notifications (work completed, attendance pending, …).",
  get_announcements: "Current company announcements that apply to the speaker (title, message, priority).",
  search_erp: "Universal ERP search: finds people (name, department, designation), batches, students, courses, leads, work tasks and assets matching a name or words — only in modules the speaker may see. Use when you don't know which module something belongs to.",
  get_erp_knowledge: "How the ERP works (rules and workflows, not live data): leave policy, leave cancellation, payroll / LOP, attendance engine, class schedule and why a class is missing, attendance reminders, Live Classes, holidays, assets, sales pipeline, work assignment, media approvals, notifications. Call before explaining any process.",
};

/** Who may call each tool — from the server-resolved permissions only. */
const ACCESS: Record<ToolName, (a: JarvisAuthContext) => boolean> = {
  get_todays_classes: (a) => can(a, "academic.all") || can(a, "academic.own"),
  get_unmarked_class_attendance: (a) => can(a, "academic.all") || can(a, "academic.own"),
  get_upcoming_batches: (a) => can(a, "academic.all"),
  get_trainers_on_leave: (a) => can(a, "academic.all") || can(a, "hr.attendance"),
  get_employee_attendance_summary: (a) => can(a, "hr.attendance"),
  get_sales_summary: (a) => can(a, "sales.all") || can(a, "sales.own"),
  get_top_performing_counselor: (a) => can(a, "sales.all"),
  query_crm_leads: (a) => can(a, "sales.all") || can(a, "sales.own"),
  get_erp_metrics: (a) => metricDepartments(a).length > 0,
  get_my_tasks: (a) => can(a, "self"),
  get_my_attendance_and_leave: (a) => can(a, "self"),
  get_company_status: (a) => can(a, "org") || can(a, "hr.attendance") || can(a, "academic.all") || can(a, "sales.all") || can(a, "media.all"),
  get_leave_status: (a) => can(a, "hr.attendance"),
  get_holidays: (a) => can(a, "self"),
  get_work_tasks: (a) => can(a, "work.all") || can(a, "media.all"),
  get_batch_details: (a) => can(a, "academic.all") || can(a, "academic.own"),
  get_student_info: (a) => can(a, "academic.all") || can(a, "academic.own") || can(a, "sales.all"),
  get_live_class_status: (a) => can(a, "academic.all") || can(a, "academic.own"),
  get_payroll_summary: (a) => can(a, "self"),
  get_company_assets: (a) => can(a, "self"),
  get_my_notifications: (a) => can(a, "self"),
  get_announcements: (a) => can(a, "self"),
  search_erp: (a) => can(a, "self"),
  get_erp_knowledge: () => true,
};
function metricDepartments(a: JarvisAuthContext): string[] {
  if (can(a, "org")) return ["academic", "sales", "hr", "media"];
  const d: string[] = [];
  if (can(a, "academic.all")) d.push("academic");
  if (can(a, "sales.all")) d.push("sales");
  if (can(a, "hr.attendance")) d.push("hr");
  if (can(a, "media.all")) d.push("media");
  return d;
}

export function toolDefinitions(auth: JarvisAuthContext): ToolDefinition[] {
  return (Object.keys(SCHEMAS) as ToolName[])
    .filter((n) => ACCESS[n](auth))
    .map((name) => {
      const js = z.toJSONSchema(SCHEMAS[name]) as Record<string, unknown>;
      delete js.$schema;
      return { name, description: DESCRIPTIONS[name], input_schema: js };
    });
}

export interface ToolResult { ok: boolean; data?: unknown; error?: string }

export class ToolError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ToolError("ERP_TIMEOUT")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** One day (or a capped short range) for day-scoped tools. */
function dayRange(phrase: string | undefined, maxDays = 1) {
  const r = resolveDateRange(phrase || "today");
  const to = addDays(r.from, maxDays - 1) < r.to ? addDays(r.from, maxDays - 1) : r.to;
  return { ...r, to };
}

async function resolveTrainer(id: string | undefined, name: string | undefined): Promise<{ id: string; name: string } | null | "ambiguous"> {
  const list = await academicService.getTrainerDirectory();
  if (id) { const t = list.find((x) => x.id === id); if (t) return { id: t.id, name: t.name }; }
  const q = String(name || id || "").trim().toLowerCase();
  if (!q) return null;
  const exact = list.filter((t) => t.name.toLowerCase() === q);
  const starts = list.filter((t) => t.name.toLowerCase().startsWith(q) || t.name.toLowerCase().split(/\s+/).some((w: string) => w === q));
  const contains = list.filter((t) => t.name.toLowerCase().includes(q));
  const pick = exact.length ? exact : starts.length ? starts : contains;
  if (pick.length === 1) return { id: pick[0].id, name: pick[0].name };
  return pick.length > 1 ? "ambiguous" : null;
}

/**
 * Validate + authorise + run one ERP tool. Never throws to the caller: failures come back as
 * { ok:false, error } so the LLM can tell the user the data could not be checked.
 */
export async function executeErpTool(toolName: string, args: unknown, auth: JarvisAuthContext): Promise<ToolResult> {
  if (!(toolName in SCHEMAS)) return { ok: false, error: `Unknown tool ${toolName}` };
  const name = toolName as ToolName;
  if (!ACCESS[name](auth)) return { ok: false, error: "The speaker does not have access to this information in the ERP." };
  const parsed = SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: "Invalid arguments: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") };
  try {
    return { ok: true, data: await withTimeout(run(name, parsed.data as Record<string, unknown>, auth), config.erpTimeoutMs) };
  } catch (e) {
    const msg = e instanceof ToolError && e.message === "ERP_TIMEOUT" ? "ERP data source timed out." : "ERP data could not be read.";
    console.error(`[jarvis] tool ${name} failed:`, e instanceof Error ? e.message : e);
    return { ok: false, error: msg };
  }
}

/** Resolve a spoken employee name to one active record (or an explanation string). */
async function findEmployee(name: string): Promise<{ id: string; name: string } | string> {
  const all = (await employeeDirectory()).filter((e) => String(e.employment_status || "active").toLowerCase() !== "exited");
  const q = name.trim().toLowerCase();
  const exact = all.filter((e) => String(e.full_name).toLowerCase() === q);
  const part = exact.length ? exact : all.filter((e) => String(e.full_name).toLowerCase().split(/\s+/).includes(q) || String(e.full_name).toLowerCase().includes(q));
  if (!part.length) return `No employee named "${name}" was found.`;
  if (part.length > 1) return `More than one employee matches "${name}": ${part.slice(0, 5).map((e) => e.full_name).join(", ")}. Ask which one.`;
  return { id: part[0].id, name: part[0].full_name };
}

// deno-lint-ignore no-explicit-any
async function run(name: ToolName, a: any, auth: JarvisAuthContext): Promise<unknown> {
  // Without academic.all a person only ever sees their own teaching, whatever the model asks.
  const ownOnly = !can(auth, "academic.all");
  const trainerFilter = async (): Promise<{ id: string; name: string } | null> => {
    if (ownOnly) {
      if (!auth.trainerId) throw new ToolError("NO_TRAINER");
      if (a.trainer_id || a.trainer_name) {
        const t = await resolveTrainer(a.trainer_id, a.trainer_name);
        if (t !== "ambiguous" && t && t.id !== auth.trainerId) throw new ToolError("NOT_OWN");
        if (t === "ambiguous" || !t) throw new ToolError("NOT_OWN");
      }
      return { id: auth.trainerId, name: auth.name };
    }
    if (!a.trainer_id && !a.trainer_name) return null;
    const t = await resolveTrainer(a.trainer_id, a.trainer_name);
    if (t === "ambiguous") throw new ToolError("AMBIGUOUS_TRAINER");
    if (!t) return { id: "00000000-0000-0000-0000-000000000000", name: String(a.trainer_name || a.trainer_id) };
    return t;
  };

  switch (name) {
    case "get_todays_classes": {
      let t: { id: string; name: string } | null;
      try { t = await trainerFilter(); } catch (e) {
        if (e instanceof ToolError && e.message === "AMBIGUOUS_TRAINER") return { note: `More than one trainer matches "${a.trainer_name}". Ask which one.` };
        if (e instanceof ToolError && e.message === "NO_TRAINER") return { note: "Your login is not linked to a trainer profile, so there are no classes to show." };
        if (e instanceof ToolError && e.message === "NOT_OWN") return { note: "The speaker can only see their own classes, not other trainers' schedules." };
        throw e;
      }
      const r = dayRange(a.date, 7);
      const items = await academicService.getClasses({ from: r.from, to: r.to, trainerId: t?.id ?? null, includeGroup: a.include_group, includeOneToOne: a.include_one_to_one });
      const perTrainer: Record<string, number> = {};
      items.forEach((c) => { perTrainer[c.trainer] = (perTrainer[c.trainer] || 0) + 1; });
      return {
        range: r, scope: t ? `trainer: ${t.name}` : "all Academic classes", total_classes: items.length,
        classes_per_trainer: Object.fromEntries(Object.entries(perTrainer).sort((x, y) => y[1] - x[1])),
        by_type: { group: items.filter((c) => c.class_type === "Group").length, one_to_one: items.filter((c) => c.class_type === "1:1").length, group_linked_one_to_one: items.filter((c) => c.class_type === "Group 1:1").length },
        classes: items.slice(0, 80).map(({ start_minutes: _s, batch_id: _b, trainer_id: _t, ...c }) => c),
        truncated: items.length > 80,
      };
    }
    case "get_trainers_on_leave": {
      const r = dayRange(a.date);
      const leave = await leaveService.getApprovedTrainerLeave(r.from);
      const classes = leave.length ? await academicService.getClasses({ from: r.from, to: r.from }) : [];
      return {
        date: r.from, label: r.label, trainers_on_approved_leave: leave.length,
        records: leave.map((l) => ({ ...l, affected_classes: classes.filter((c) => c.trainer_id === l.trainer_id).map((c) => `${c.start} ${c.batch}`) })),
        note: leave.length ? undefined : "No approved trainer leave found for this day.",
      };
    }
    case "get_unmarked_class_attendance": {
      let t: { id: string; name: string } | null;
      try { t = await trainerFilter(); } catch (e) {
        if (e instanceof ToolError && e.message === "AMBIGUOUS_TRAINER") return { note: `More than one trainer matches "${a.trainer_name}". Ask which one.` };
        if (e instanceof ToolError && e.message === "NO_TRAINER") return { note: "Your login is not linked to a trainer profile." };
        if (e instanceof ToolError && e.message === "NOT_OWN") return { note: "The speaker can only see their own classes, not other trainers' schedules." };
        throw e;
      }
      const r = dayRange(a.date);
      const list = await academicService.getUnmarkedAttendance({ date: r.from, trainerId: t?.id ?? null });
      const perTrainer: Record<string, number> = {};
      list.forEach((c) => { perTrainer[c.trainer] = (perTrainer[c.trainer] || 0) + 1; });
      return { date: r.from, label: r.label, unmarked_classes: list.length, per_trainer: perTrainer, classes: list.slice(0, 40), checked_at: tzDate() === r.from ? "classes still running are not counted" : undefined };
    }
    case "get_employee_attendance_summary": {
      const r = dayRange(a.date);
      return attendanceService.getEmployeeAttendanceSummary({ date: r.from, department: a.department || null });
    }
    case "get_upcoming_batches": {
      const days = a.days_ahead || 30;
      const list = await academicService.getUpcomingBatches(days);
      return { days_ahead: days, upcoming_batches: list.length, batches: list.slice(0, 30) };
    }
    case "get_sales_summary":
      return salesService.getSalesSummary(resolveDateRange(a.date_range), can(auth, "sales.all") ? null : { id: auth.employeeId, name: auth.name });
    case "get_top_performing_counselor":
      return salesService.getTopCounselor(a.timeframe_days, a.metric);
    case "query_crm_leads":
      return crmService.queryLeads(a.status, a.limit, can(auth, "sales.all") ? null : auth.employeeId);
    case "get_my_tasks":
      return selfService.getMyTasks(auth.email, a.status);
    case "get_my_attendance_and_leave":
      return selfService.getMyAttendanceAndLeave(auth.employeeId, a.month);
    case "get_company_status": {
      const r = dayRange(a.date);
      return companyStatus(r.from, { hr: can(auth, "hr.attendance"), academic: can(auth, "academic.all"), sales: can(auth, "sales.all"), work: can(auth, "work.all") || can(auth, "media.all") });
    }
    case "get_leave_status": {
      const r = dayRange(a.date);
      return hrExtra.leaveOn(r.from, a.department || null, a.person || null);
    }
    case "get_holidays":
      return hrExtra.holidays(resolveDateRange(a.date_range || "this_month"), auth.department);
    case "get_work_tasks": {
      // Media Head (media.all without work.all) only sees Media / Production work.
      const only = can(auth, "work.all") ? null : "production";
      return workExtra.tasks({ status: a.status, department: a.department || null, onlyDepartment: only, employee: a.employee_name || null,
        range: a.status === "completed" ? resolveDateRange(a.date_range || "today") : (a.date_range ? resolveDateRange(a.date_range) : null) });
    }
    case "get_batch_details":
      return academicExtra.batchDetails(a.batch_name, can(auth, "academic.all") ? null : (auth.trainerId || "00000000-0000-0000-0000-000000000000"));
    case "get_student_info":
      return academicExtra.studentInfo(a.student_name, can(auth, "academic.all") || can(auth, "sales.all") ? null : auth.name);
    case "get_live_class_status": {
      const r = dayRange(a.date);
      return academicExtra.liveClasses(r.from, can(auth, "academic.all") ? null : auth.trainerId);
    }
    case "get_payroll_summary": {
      let empId = auth.employeeId;
      if (a.employee_name) {
        const hit = await findEmployee(a.employee_name);
        if (typeof hit === "string") return { note: hit };
        if (hit.id !== auth.employeeId && !can(auth, "hr.payroll")) return { note: "The speaker can only see their own payroll." };
        empId = hit.id;
      }
      const today = tzDate();
      const month = a.month || today.slice(0, 7);
      const res = await hrExtra.payroll(empId, month) as Record<string, unknown>;
      if (!a.month && res.note) { const prev = addDays(today.slice(0, 8) + "01", -1).slice(0, 7); return hrExtra.payroll(empId, prev); }
      return res;
    }
    case "get_company_assets": {
      if (a.mine || (!a.employee_name && !can(auth, "hr.payroll"))) return hrExtra.assets({ employeeId: auth.employeeId });
      if (a.employee_name) {
        const hit = await findEmployee(a.employee_name);
        if (typeof hit === "string") return { note: hit };
        if (hit.id !== auth.employeeId && !can(auth, "hr.payroll")) return { note: "The speaker can only see their own assets." };
        return hrExtra.assets({ employeeId: hit.id });
      }
      return hrExtra.assets({ status: a.status || null, query: a.query || null });
    }
    case "get_my_notifications":
      return commonExtra.myNotifications(auth.email);
    case "get_announcements":
      return commonExtra.announcements(auth.employeeId, auth.department, a.limit || 5);
    case "search_erp": {
      const allowed: string[] = ["people"];
      if (can(auth, "academic.all") || can(auth, "academic.own")) allowed.push("academic");
      if (can(auth, "sales.all") || can(auth, "sales.own")) allowed.push("sales");
      if (can(auth, "work.all") || can(auth, "media.all")) allowed.push("work");
      if (can(auth, "hr.payroll")) allowed.push("assets");
      const mods = !a.module || a.module === "any" ? allowed : allowed.filter((m) => m === a.module);
      if (!mods.length) return { note: `The speaker does not have access to ${a.module} data.` };
      return commonExtra.search(a.query, mods, { trainerName: can(auth, "academic.all") ? null : auth.name, salesOwnId: can(auth, "sales.all") ? null : auth.employeeId });
    }
    case "get_erp_knowledge":
      return searchKnowledge(a.question, a.module || null);
    case "get_erp_metrics": {
      const r = resolveDateRange(a.date_range);
      const allowed = metricDepartments(auth);
      const want = a.department === "all" ? allowed : allowed.filter((d) => d === a.department);
      if (!want.length) return { note: `The speaker does not have access to ${a.department} metrics.` };
      const out: Record<string, unknown> = { range: r };
      const jobs: Record<string, () => Promise<unknown>> = {
        academic: () => metricsService.academic(r),
        sales: async () => { const s = await salesService.getSalesSummary(r); return { leads: s.leads, enrollments: s.enrollments, conversion_rate_percent: s.conversion_rate_percent, need_first_contact: s.need_first_contact }; },
        hr: () => metricsService.hr(r),
        media: () => metricsService.media(r),
      };
      const res = await Promise.allSettled(want.map((d) => jobs[d]()));
      want.forEach((d, i) => { const x = res[i]; out[d] = x.status === "fulfilled" ? x.value : { error: "could not be read" }; });
      return out;
    }
  }
}
