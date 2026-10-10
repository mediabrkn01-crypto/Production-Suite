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

// ── Future attendance (NOT used in Version 1 — attendance is never finalised from Meet) ──
//   Class ends → conference record → participants → ERP *suggests* attendance → trainer verifies.

export async function listConferenceRecords(spaceName: string): Promise<any[]> {
  const j = await gfetch(`${BASE}/conferenceRecords?filter=${encodeURIComponent(`space.name="${spaceName}"`)}`);
  return j?.conferenceRecords || [];
}

export async function listParticipants(conferenceRecordName: string): Promise<any[]> {
  const j = await gfetch(`${BASE}/${conferenceRecordName}/participants?pageSize=100`);
  return j?.participants || [];
}
