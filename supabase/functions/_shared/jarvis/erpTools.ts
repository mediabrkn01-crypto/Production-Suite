// Jarvis ERP tools — the ONLY way the LLM can touch company data.
//   • read-only: every tool maps to a fixed service read in erpServices.ts (no SQL, no writes)
//   • arguments validated with Zod before anything runs
//   • authorised per tool against the server-resolved JarvisAuthContext
//   • results are compact JSON (only the rows needed to answer), capped in size
import { z } from "npm:zod@4.6.5";
import type { JarvisAuthContext, JarvisScope } from "./auth.ts";
import { config } from "./config.ts";
import { academicService, attendanceService, crmService, leaveService, metricsService, salesService } from "./erpServices.ts";
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
  get_erp_metrics: "Headline KPIs for a department (academic, sales, hr, media) or all, for a period.",
};

/** Which access scopes may call each tool. */
const ACCESS: Record<ToolName, JarvisScope[]> = {
  get_todays_classes: ["org", "academic", "trainer"],
  get_unmarked_class_attendance: ["org", "academic", "trainer"],
  get_upcoming_batches: ["org", "academic"],
  get_trainers_on_leave: ["org", "academic"],
  get_employee_attendance_summary: ["org"],
  get_sales_summary: ["org"],
  get_top_performing_counselor: ["org"],
  query_crm_leads: ["org"],
  get_erp_metrics: ["org", "academic"],
};

export function toolDefinitions(auth: JarvisAuthContext): ToolDefinition[] {
  return (Object.keys(SCHEMAS) as ToolName[])
    .filter((n) => ACCESS[n].includes(auth.scope))
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
  if (!ACCESS[name].includes(auth.scope)) return { ok: false, error: "Not permitted for your role." };
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

// deno-lint-ignore no-explicit-any
async function run(name: ToolName, a: any, auth: JarvisAuthContext): Promise<unknown> {
  // Trainers only ever see their own teaching, whatever the model asks for.
  const ownOnly = auth.scope === "trainer";
  const trainerFilter = async (): Promise<{ id: string; name: string } | null> => {
    if (ownOnly) {
      if (!auth.trainerId) throw new ToolError("NO_TRAINER");
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
      return salesService.getSalesSummary(resolveDateRange(a.date_range));
    case "get_top_performing_counselor":
      return salesService.getTopCounselor(a.timeframe_days, a.metric);
    case "query_crm_leads":
      return crmService.queryLeads(a.status, a.limit);
    case "get_erp_metrics": {
      const r = resolveDateRange(a.date_range);
      const want = auth.scope === "academic" ? ["academic"] : (a.department === "all" ? ["academic", "sales", "hr", "media"] : [a.department]);
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
