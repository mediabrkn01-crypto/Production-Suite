// syncGuard — protects the organizer Google account from being hammered.
//
//  classify()          Google error → calendar_limit | rate_limit | auth | not_found | transient | other
//  backoffMs()         capped exponential backoff with ±20 % jitter
//  calendarPause()     organizer-wide pause after "Calendar usage limits exceeded" (quotaExceeded):
//                      no Calendar write is attempted until calendar_paused_until; the pause
//                      doubles on each repeat (15 min → 30 → 1 h … capped at 12 h) and is cleared
//                      by the first successful write. Google gives no fixed reset time for this
//                      limit, so the ERP never promises one.
import { adminClient } from "../_shared/jarvis/auth.ts";
import { GoogleApiError } from "../_shared/google/googleAuthService.ts";

export type GKind = "calendar_limit" | "rate_limit" | "auth" | "not_found" | "transient" | "other";
export interface GInfo { kind: GKind; status: number | null; reason: string; message: string }

export function classify(e: unknown): GInfo {
  if (e instanceof GoogleApiError) {
    const status = e.status || null, reason = String(e.reason || ""), message = e.message || "";
    const r = reason.toLowerCase();
    if (r === "quotaexceeded" || /usage limits exceeded/i.test(message)) return { kind: "calendar_limit", status, reason: reason || "quotaExceeded", message };
    if (r === "ratelimitexceeded" || r === "userratelimitexceeded" || status === 429) return { kind: "rate_limit", status, reason: reason || "rateLimitExceeded", message };
    if (status === 401 || r === "not_connected" || r === "auth_failed" || r === "autherror" || r === "invalid_grant") return { kind: "auth", status, reason, message };
    if (status === 404 || status === 410) return { kind: "not_found", status, reason, message };
    if (status && status >= 500) return { kind: "transient", status, reason, message };
    return { kind: "other", status, reason, message };
  }
  const message = (e as Error)?.message || String(e);
  return { kind: /network|fetch|timed? ?out/i.test(message) ? "transient" : "other", status: null, reason: "", message };
}

/** min(cap, base·2^(n-1)) with ±20 % jitter. n starts at 1. */
export function backoffMs(n: number, baseMs: number, capMs: number) {
  const raw = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, n - 1)));
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}
export const RETRY = {
  rate: (n: number) => backoffMs(n, 30_000, 30 * 60_000),          // 30 s → 1 → 2 → 4 … ≤ 30 min
  transient: (n: number) => backoffMs(n, 60_000, 60 * 60_000),     // 1 min … ≤ 1 h
  pause: (level: number) => backoffMs(level, 15 * 60_000, 12 * 3600_000), // 15 min … ≤ 12 h
};

export const LIMIT_MSG = "Google Calendar has temporarily limited event creation. The system will retry automatically.";
export const RATE_MSG = "Google is busy right now. The system will retry automatically.";

const cfg = () => adminClient().from("academic_meet_config");

/** ISO time until which Calendar writes are paused, or null. */
export async function calendarPause(): Promise<{ until: string; reason: string | null } | null> {
  const { data } = await cfg().select("calendar_paused_until,calendar_pause_reason").eq("id", 1).maybeSingle().then((r) => r, () => ({ data: null }));
  const until = data?.calendar_paused_until;
  return until && Date.parse(until) > Date.now() ? { until, reason: data?.calendar_pause_reason || null } : null;
}

export async function pauseCalendar(g: GInfo): Promise<string> {
  const { data } = await cfg().select("calendar_pause_level").eq("id", 1).maybeSingle().then((r) => r, () => ({ data: null }));
  const level = (data?.calendar_pause_level || 0) + 1;
  const until = new Date(Date.now() + RETRY.pause(level)).toISOString();
  await cfg().update({
    calendar_paused_until: until, calendar_pause_level: level, calendar_pause_reason: g.reason || g.kind,
    calendar_last_error: { status: g.status, reason: g.reason, message: g.message, at: new Date().toISOString() },
  }).eq("id", 1).then(() => {}, () => {});
  return until;
}

export function clearPause() {
  return cfg().update({ calendar_paused_until: null, calendar_pause_level: 0, calendar_pause_reason: null }).eq("id", 1).gt("calendar_pause_level", 0).then(() => {}, () => {});
}

/** Single queue runner across all browsers/requests (concurrency 1). */
export async function takeQueueLock(ms: number): Promise<boolean> {
  const now = new Date().toISOString(), until = new Date(Date.now() + ms).toISOString();
  const { data } = await cfg().update({ queue_lock_until: until }).eq("id", 1).or(`queue_lock_until.is.null,queue_lock_until.lt.${now}`).select("id").maybeSingle().then((r) => r, () => ({ data: null }));
  return !!data;
}
export function releaseQueueLock() {
  return cfg().update({ queue_lock_until: null }).eq("id", 1).then(() => {}, () => {});
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
