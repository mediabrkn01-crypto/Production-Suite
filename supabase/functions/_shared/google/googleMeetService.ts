// googleMeetService — Google Meet REST API (v2). Version 1 only resolves the Meet *space* that
// Calendar created (stored as google_meet_space_name), so later features — co-hosts, conference
// records, participants, recordings, transcripts — can address it directly.
import { gfetch } from "./googleAuthService.ts";

const BASE = "https://meet.googleapis.com/v2";

/** spaces/{meetingCode} → { name: "spaces/…", meetingUri }. Best effort: null when not permitted. */
export async function getSpaceByMeetingCode(code: string): Promise<{ name: string; meetingUri?: string } | null> {
  if (!code) return null;
  try { return await gfetch(`${BASE}/spaces/${encodeURIComponent(code)}`); } catch { return null; }
}

// ── Meet report (after the class): conference records → participants → sessions ──────────
// Used only to SUGGEST attendance; the trainer / Academic team confirms it in Class & Attendance.

async function listAll(url: string, key: string): Promise<any[]> {
  const out: any[] = [];
  let token = "";
  for (let i = 0; i < 20; i++) {
    const j = await gfetch(url + (url.includes("?") ? "&" : "?") + "pageSize=100" + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    out.push(...(j?.[key] || []));
    token = j?.nextPageToken || "";
    if (!token) break;
  }
  return out;
}

export function listConferenceRecords(spaceName: string): Promise<any[]> {
  return listAll(`${BASE}/conferenceRecords?filter=${encodeURIComponent(`space.name="${spaceName}"`)}`, "conferenceRecords");
}

export function listParticipants(conferenceRecordName: string): Promise<any[]> {
  return listAll(`${BASE}/${conferenceRecordName}/participants`, "participants");
}

export function listParticipantSessions(participantName: string): Promise<any[]> {
  return listAll(`${BASE}/${participantName}/participantSessions`, "participantSessions");
}
