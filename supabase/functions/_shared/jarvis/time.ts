// Business-timezone (Asia/Kolkata) date helpers. Every ERP date Jarvis queries is resolved
// here first, so a UTC server clock can never shift "today" into yesterday.
import { config } from "./config.ts";

const TZ = () => config.timezone;

/** YYYY-MM-DD for an instant, in the business timezone. */
export function tzDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ() }).format(d);
}
/** Minutes since midnight for an instant, in the business timezone. */
export function tzMinutes(d: Date = new Date()): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d).split(":").map(Number);
  return (h % 24) * 60 + m;
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dow(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
}
export function fmtMinutes(m: number | null | undefined): string {
  if (m == null || isNaN(m)) return "";
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export interface DateRange { from: string; to: string; label: string }

/**
 * Resolve a natural date phrase to an explicit inclusive range in the business timezone.
 * Accepts: today | tomorrow | yesterday | this_week | last_week | next_week | this_month |
 * last_month | last_N_days | next_N_days | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD (also "to").
 * Weeks run Monday–Sunday. Unknown phrases fall back to today (and say so in the label).
 */
export function resolveDateRange(input: string | undefined | null, now: Date = new Date()): DateRange {
  const today = tzDate(now);
  const raw = String(input ?? "today").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const r = (from: string, to: string, label: string): DateRange => ({ from, to, label });
  const span = String(input ?? "").match(/(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|—|-{2})\s*(\d{4}-\d{2}-\d{2})/i);
  if (span && isIsoDate(span[1]) && isIsoDate(span[2])) {
    const [a, b] = span[1] <= span[2] ? [span[1], span[2]] : [span[2], span[1]];
    return r(a, b, `${a} to ${b}`);
  }
  if (isIsoDate(String(input ?? "").trim())) { const d = String(input).trim(); return r(d, d, d); }
  const monday = (iso: string) => addDays(iso, -((dow(iso) + 6) % 7));
  const monthStart = (iso: string) => iso.slice(0, 8) + "01";
  const monthEnd = (iso: string) => { const [y, m] = iso.split("-").map(Number); const d = new Date(Date.UTC(y, m, 0)); return d.toISOString().slice(0, 10); };
  switch (raw) {
    case "today": case "": return r(today, today, "today");
    case "tomorrow": { const d = addDays(today, 1); return r(d, d, "tomorrow"); }
    case "yesterday": { const d = addDays(today, -1); return r(d, d, "yesterday"); }
    case "this_week": { const m = monday(today); return r(m, addDays(m, 6), "this week"); }
    case "last_week": { const m = addDays(monday(today), -7); return r(m, addDays(m, 6), "last week"); }
    case "next_week": { const m = addDays(monday(today), 7); return r(m, addDays(m, 6), "next week"); }
    case "this_month": return r(monthStart(today), monthEnd(today), "this month");
    case "last_month": { const prev = addDays(monthStart(today), -1); return r(monthStart(prev), monthEnd(prev), "last month"); }
    case "next_month": { const next = addDays(monthEnd(today), 1); return r(monthStart(next), monthEnd(next), "next month"); }
    case "this_year": return r(today.slice(0, 4) + "-01-01", today.slice(0, 4) + "-12-31", "this year");
    case "all_time": case "all": return r("2000-01-01", today, "all time");
  }
  const lastN = raw.match(/^(?:last|past)_(\d{1,3})_days?$/);
  if (lastN) { const n = Math.max(1, +lastN[1]); return r(addDays(today, -(n - 1)), today, `last ${n} days`); }
  const nextN = raw.match(/^next_(\d{1,3})_days?$/);
  if (nextN) { const n = Math.max(1, +nextN[1]); return r(today, addDays(today, n - 1), `next ${n} days`); }
  return r(today, today, "today (unrecognised range, defaulted)");
}

/** The calendar day (business tz) of a timestamp string, or "" when missing. */
export function tsDay(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts).slice(0, 10) : tzDate(d);
}

/**
 * leave-policy.js reads wall-clock time with Date#getHours() (it was written for browsers in
 * India). The edge runtime runs in UTC, so timestamps handed to it are rewritten to "business
 * wall time expressed as UTC". When the process already runs in the business timezone this is
 * a no-op.
 */
const PROCESS_IS_IST = new Date().getTimezoneOffset() === -330;
export function toWallClock(ts: string | Date | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts as string);
  if (isNaN(d.getTime())) return null;
  if (PROCESS_IS_IST || config.timezone !== "Asia/Kolkata") return d.toISOString();
  return new Date(d.getTime() + 330 * 60000).toISOString();
}
export function wallNow(): Date {
  return new Date(toWallClock(new Date())!);
}
