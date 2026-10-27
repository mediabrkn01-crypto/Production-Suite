// Server copy of session-number.js (browser) — the SAME rule, kept in step: which session of
// its batch a class is. Marked class → its attendance.session_num (kept in class-date order by
// the fn_renumber_attendance trigger). Not marked yet → sessions done before it + the batch's
// still-to-come classes between today and it + 1, where still-to-come = scheduled occurrences
// (class days, education holidays, postponements) minus cancelled classes and classes on
// approved trainer leave. Group 1:1 sessions use oto_sessions.session_number. Nothing is written.
// deno-lint-ignore-file no-explicit-any
import { loadLeaveIndex } from "./trainer-availability.ts";
type Row = Record<string, any>;
const day = (v: unknown) => (v == null ? "" : String(v).slice(0, 10));

export function computeSessionNumber(opt: { date: string; attendance: Row[]; upcoming?: string[]; today: string }): number | null {
  const date = day(opt.date), today = day(opt.today);
  if (!date) return null;
  const marked = new Set<string>(), undated = new Set<number>(), doneBefore = new Set<string>();
  let onDay = 0;
  for (const r of opt.attendance || []) {
    if (!r) continue;
    const d = day(r.session_date), present = !r.status || r.status === "present";
    if (!d) { if (present && r.session_num != null) undated.add(+r.session_num); continue; }
    marked.add(d);
    if (d === date && r.session_num != null) onDay = Math.max(onDay, +r.session_num);
    if (present && d < date) doneBefore.add(d);
  }
  if (onDay) return onDay;
  const pending = new Set((opt.upcoming || []).map(day).filter((u) => u && u >= today && u < date && !marked.has(u)));
  return undated.size + doneBefore.size + pending.size + 1;
}

export const sessionLabel = (n: number | null | undefined) => (n && n > 0 ? String(n).padStart(2, "0") : "");

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const addDay = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dowOf = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const hmMin = (t: unknown) => { const m = String(t || "").match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
export const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

/** Session number of a regular batch class on `date` (the class's actual date, after any
 *  postponement). batch needs id,name,status,trainer_id,day_pattern,course_id,start_date,
 *  group_classes_completed_at; startMin/dur = the batch's normal slot (for the leave check). */
export async function sessionNumberForClass(db: any, batch: Row, date: string, startMin: number | null, dur: number): Promise<number | null> {
  if (!batch?.name || !date) return null;
  const today = istToday();
  const { data: att } = await db.from("attendance").select("session_date,session_num,status").eq("batch_name", batch.name).range(0, 9999);
  const attendance = att || [];
  if (date <= today || attendance.some((r: Row) => day(r.session_date) === date && r.session_num != null))
    return computeSessionNumber({ date, attendance, today });

  // Still-to-come classes of this batch between today and `date` — the generateBatchOccurrences rule.
  let days = String(batch.day_pattern || "");
  if (!days && batch.course_id) { const { data: c } = await db.from("courses").select("default_days").eq("id", batch.course_id).maybeSingle(); days = String(c?.default_days || ""); }
  const want = new Set(days.split(",").map((t) => t.replace(/\s*·.*$/, "").trim()).filter((t) => t in DOW).map((t) => DOW[t]));
  const end = addDay(date, -1);
  const [hR, pR, cR, tR] = await Promise.all([
    db.from("hr_holidays").select("*").gte("holiday_date", today).lte("holiday_date", end),
    db.from("class_postponements").select("original_date,new_date,new_start").eq("kind", "class").eq("batch_id", batch.id).eq("status", "active"),
    db.from("academic_live_classes").select("original_date").eq("class_kind", "class").eq("batch_id", batch.id).eq("class_status", "cancelled").gte("class_date", today),
    batch.trainer_id ? db.from("trainers").select("id,hr_employee_id").eq("id", batch.trainer_id) : Promise.resolve({ data: [] }),
  ]);
  const holiday = new Set((hR.data || []).filter((h: Row) => (h.holiday_scope || "all") !== "departments" || (h.departments || []).map((x: any) => String(x).toLowerCase()).includes("education")).map((h: Row) => day(h.holiday_date)));
  const bStart = day(batch.start_date) || "0000-01-01";
  let bEnd = String(batch.status || "").toLowerCase() === "active" ? "9999-12-31" : (day(batch.expected_completion_date) || "9999-12-31");
  if (batch.group_classes_completed_at && day(batch.group_classes_completed_at) < bEnd) bEnd = day(batch.group_classes_completed_at);
  const isClassDay = (d: string) => want.has(dowOf(d)) && d >= bStart && d <= bEnd && !holiday.has(d);
  const cancelled = new Set((cR.data || []).map((r: Row) => day(r.original_date)));
  const moves = (pR.data || []).filter((p: Row) => isClassDay(day(p.original_date)));
  const movedFrom = new Set(moves.map((p: Row) => day(p.original_date)));
  const occ: { orig: string; date: string; start: number | null }[] = [];
  if (want.size) for (let d = today; d <= end; d = addDay(d, 1)) if (isClassDay(d) && !movedFrom.has(d)) occ.push({ orig: d, date: d, start: startMin });
  for (const p of moves) { const nd = day(p.new_date); if (nd >= today && nd <= end) occ.push({ orig: day(p.original_date), date: nd, start: hmMin(p.new_start) }); }
  const lv = await loadLeaveIndex(db, today, end, tR.data || []);
  const upcoming = occ.filter((o) => !cancelled.has(o.orig) && !lv.leaveFor(batch.trainer_id, o.date, o.start, o.start == null ? null : o.start + dur)).map((o) => o.date);
  return computeSessionNumber({ date, attendance, upcoming, today });
}
