// googleCalendarService — Calendar API v3 calls for class events (organizer account).
// Every write uses sendUpdates=all so Google itself emails trainers/students the invitation,
// the time change, or the cancellation. No separate mail system.
import { gfetch, GoogleApiError } from "./googleAuthService.ts";

const BASE = "https://www.googleapis.com/calendar/v3/calendars";
const cal = (calendarId: string) => `${BASE}/${encodeURIComponent(calendarId)}/events`;

/** Insert with a caller-chosen event id (idempotent: a repeat insert returns 409). */
export function insertEvent(calendarId: string, body: Record<string, unknown>) {
  return gfetch(`${cal(calendarId)}?conferenceDataVersion=1&sendUpdates=all`, { method: "POST", body: JSON.stringify(body) });
}

export function getEvent(calendarId: string, eventId: string) {
  return gfetch(`${cal(calendarId)}/${encodeURIComponent(eventId)}?conferenceDataVersion=1`);
}

export function patchEvent(calendarId: string, eventId: string, body: Record<string, unknown>, notify = true) {
  return gfetch(`${cal(calendarId)}/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=${notify ? "all" : "none"}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** Cancels the event (attendees get Google's cancellation email). Already-gone counts as done. */
export async function cancelEvent(calendarId: string, eventId: string) {
  try {
    await gfetch(`${cal(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GoogleApiError && (e.status === 410 || e.status === 404)) return;
    throw e;
  }
}

/** The organizer calendar's own id (= the account email for "primary"). */
export async function calendarIdentity(calendarId: string, token?: string): Promise<string | null> {
  const j = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {}, token);
  return j?.id || null;
}

/** Meet link + meeting code from an event's conference data. */
export function meetFromEvent(ev: any): { url: string | null; code: string | null; pending: boolean; failed: boolean } {
  const cd = ev?.conferenceData;
  const video = (cd?.entryPoints || []).find((p: any) => p.entryPointType === "video");
  const st = cd?.createRequest?.status?.statusCode;
  return { url: ev?.hangoutLink || video?.uri || null, code: cd?.conferenceId || null, pending: st === "pending", failed: st === "failure" };
}
