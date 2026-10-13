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

/** New Meet space owned by the organizer. OPEN = anyone with the link joins without knocking
 *  (students without an email aren't invited, and the organizer is never in the call to admit them). */
export function createSpace(accessType: "OPEN" | "TRUSTED" = "OPEN"): Promise<{ name: string; meetingUri: string; meetingCode: string }> {
  return gfetch(`${BASE}/spaces`, { method: "POST", body: JSON.stringify({ config: { accessType } }) });
}

/** Calendar conferenceData that attaches an existing Meet space to an event. */
export function conferenceFor(space: { meetingUri: string; meetingCode: string }) {
  return {
    conferenceId: space.meetingCode,
    conferenceSolution: { key: { type: "hangoutsMeet" } },
    entryPoints: [{ entryPointType: "video", uri: space.meetingUri, label: space.meetingUri.replace(/^https?:\/\//, "") }],
  };
}

// ── Space members (trainer = COHOST; the organizer account stays the owner) ───────────────

export async function listMembers(spaceName: string): Promise<any[]> {
  return listAll(`${BASE}/${spaceName}/members`, "members");
}

export function addMember(spaceName: string, email: string, role: "COHOST" | "MEMBER" = "COHOST") {
  return gfetch(`${BASE}/${spaceName}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
}

export function removeMember(memberName: string) {
  return gfetch(`${BASE}/${memberName}`, { method: "DELETE" });
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
