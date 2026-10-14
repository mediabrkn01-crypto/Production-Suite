// owners — WHICH Google account owns a class meeting.
//   trainer   the class trainer's own connected Google account (normal case): the trainer is the
//             real Calendar organizer + Meet owner, enters directly and admits students.
//   fallback  the central organizer (Classes BRK) — only when the Academic team explicitly chooses
//             it, or for classes created before trainer accounts existed.
import { adminClient } from "../_shared/jarvis/auth.ts";
import { type GoogleActor } from "../_shared/google/googleAuthService.ts";
import { decryptToken } from "../_shared/google/tokenCrypto.ts";

export const ORG: GoogleActor = { kind: "org", key: "org", email: null };

export interface TrainerConn { employeeId: string; trainerId: string | null; email: string; status: string; connectedAt: string | null }

/** trainers.id → hr_employees.id */
export async function employeeOfTrainer(trainerId: string | null): Promise<string | null> {
  if (!trainerId) return null;
  const { data } = await adminClient().from("trainers").select("hr_employee_id").eq("id", trainerId).maybeSingle();
  return data?.hr_employee_id || null;
}

/** Connection summary (no token). */
export async function connectionOf(employeeId: string | null): Promise<TrainerConn | null> {
  if (!employeeId) return null;
  const { data } = await adminClient().from("employee_google_connections").select("employee_id,trainer_id,google_email,connection_status,connected_at").eq("employee_id", employeeId).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return data ? { employeeId: data.employee_id, trainerId: data.trainer_id, email: data.google_email, status: data.connection_status, connectedAt: data.connected_at } : null;
}

/** Google actor for an employee's connected account (null when not connected / revoked). */
export async function actorForEmployee(employeeId: string | null): Promise<GoogleActor | null> {
  if (!employeeId) return null;
  const { data } = await adminClient().from("employee_google_connections").select("employee_id,google_email,refresh_token_encrypted,connection_status").eq("employee_id", employeeId).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  if (!data || data.connection_status !== "connected") return null;
  return { kind: "trainer", key: "emp:" + data.employee_id, email: data.google_email, employeeId: data.employee_id, refreshToken: await decryptToken(data.refresh_token_encrypted) };
}

export async function actorForTrainer(trainerId: string | null) { return actorForEmployee(await employeeOfTrainer(trainerId)); }

/** The account that owns an existing class row (trainer-owned rows need that trainer's account). */
export async function actorForRow(row: any): Promise<GoogleActor> {
  if (row?.google_organizer_kind === "trainer" && row.google_organizer_employee_id) {
    const a = await actorForEmployee(row.google_organizer_employee_id);
    // Disconnected since: calls fail with TRAINER_NOT_CONNECTED instead of silently using another account.
    return a || { kind: "trainer", key: "emp:" + row.google_organizer_employee_id, email: row.google_organizer_email || null, employeeId: row.google_organizer_employee_id };
  }
  return ORG;
}

export async function actorForKey(key: string): Promise<GoogleActor> {
  if (!key) return ORG;
  const { data } = await adminClient().from("academic_live_classes").select("google_organizer_kind,google_organizer_employee_id,google_organizer_email").eq("occurrence_key", key).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return actorForRow(data);
}
