// Server copy of trainer-availability.js (browser) — the SAME rule, kept line-for-line in step:
// approved HR leave is an availability override. Only status 'approved' counts (pending /
// rejected / cancelled never suppress); Work From Home is not leave. A leave covers
// 00:00–24:00 of every date start_date..end_date, a morning half 00:00–HALF_SPLIT and an
// afternoon half HALF_SPLIT–24:00 (Asia/Kolkata wall time). A class is suppressed when
// leave_start < class_end AND leave_end > class_start. One query per date range, never per class.
// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;
const DAY = 1440;
export const HALF_SPLIT = 13 * 60;

const isWfh = (l: Row) => /work\s*from\s*home|\bwfh\b/i.test(String(l?.leave_type || ""));
const isMorning = (l: Row) => /^(morning|hd-m)$/i.test(String(l.half_day_type || ""));
const isAfternoon = (l: Row) => /^(afternoon|hd-a)$/i.test(String(l.half_day_type || ""));

export function windowOf(l: Row, dateISO: string): [number, number] | null {
  const s = String(l.start_date || "").slice(0, 10), e = String(l.end_date || l.start_date || "").slice(0, 10);
  if (!s || dateISO < s || dateISO > e) return null;
  if (isMorning(l)) return [0, HALF_SPLIT];
  if (isAfternoon(l)) return [HALF_SPLIT, DAY];
  return [0, DAY];
}

export interface LeaveIndex {
  leaveFor(trainerId: string | null | undefined, dateISO: string, startMin: number | null, endMin: number | null): Row | null;
}

export function indexLeave(rows: Row[], trainers: Row[]): LeaveIndex {
  const byEmp: Record<string, Row[]> = {}, empOf: Record<string, string> = {};
  for (const t of trainers || []) if (t?.id != null && t.hr_employee_id) empOf[String(t.id)] = String(t.hr_employee_id);
  for (const l of rows || []) {
    if (!l || String(l.status || "approved").toLowerCase() !== "approved" || isWfh(l) || !l.employee_id) continue;
    (byEmp[String(l.employee_id)] ||= []).push(l);
  }
  return {
    leaveFor(trainerId, dateISO, startMin, endMin) {
      const list = trainerId ? byEmp[empOf[String(trainerId)]] : null;
      if (!list || !dateISO) return null;
      const cs = startMin == null || isNaN(startMin) ? 0 : +startMin;
      const ce = endMin == null || isNaN(endMin) || +endMin <= cs ? (startMin == null ? DAY : cs + 1) : +endMin;
      for (const l of list) { const w = windowOf(l, dateISO); if (w && w[0] < ce && w[1] > cs) return l; }
      return null;
    },
  };
}

/** One query: every approved leave overlapping [from, to] for the given trainers. */
export async function loadLeaveIndex(db: any, from: string, to: string, trainers: Row[]): Promise<LeaveIndex> {
  const emp = [...new Set((trainers || []).map((t) => t?.hr_employee_id).filter(Boolean).map(String))];
  if (!emp.length) return indexLeave([], trainers);
  const { data, error } = await db.from("hr_leave_requests").select("employee_id,leave_type,start_date,end_date,half_day_type,status")
    .eq("status", "approved").lte("start_date", to).gte("end_date", from).in("employee_id", emp);
  return indexLeave(error ? [] : (data || []), trainers);
}
