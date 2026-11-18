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

export type TrainerProfileState = "linked" | "no_profile" | "not_linked" | "not_trainer";
export interface TrainerProfile { state: TrainerProfileState; employeeId: string | null; trainerId: string | null }

/** Is the signed-in person an Academic trainer whose profile is linked to THEIR HR record?
 *    linked       trainers row with hr_employee_id = this employee  → may connect Google Meet
 *    not_linked   a trainer profile resolved for this sign-in but linked to another / no HR record
 *    no_profile   an Education trainer/coach in HR with no Academic trainer profile yet
 *    not_trainer  everyone else
 *  Never creates or relinks anything — provisioning stays with the HR → Academic sync. */
export async function trainerProfileOf(a: { employeeId: string; trainerId: string | null; role: string; permissions: string[] }): Promise<TrainerProfile> {
  if (a.trainerId) {
    const emp = await employeeOfTrainer(a.trainerId);
    return emp && emp === a.employeeId
      ? { state: "linked", employeeId: emp, trainerId: a.trainerId }
      : { state: "not_linked", employeeId: null, trainerId: a.trainerId };
  }
  const { data: e } = await adminClient().from("hr_employees").select("division,department,designation,system_role").eq("id", a.employeeId).maybeSingle();
  const teaches = !!e && (String(e.system_role || "").toLowerCase() === "trainer"
    || (e.division === "education" && /coach|trainer/i.test(`${e.department || ""} ${e.designation || ""}`)));
  return { state: teaches ? "no_profile" : "not_trainer", employeeId: null, trainerId: null };
}

export const TRAINER_PROFILE_MSG: Record<Exclude<TrainerProfileState, "linked">, { code: string; message: string }> = {
  no_profile: { code: "TRAINER_PROFILE_MISSING", message: "Your Academic trainer profile hasn't been created yet. Ask the Academic Head to open Academic → Coaches (it syncs trainer profiles from HR), then try again." },
  not_linked: { code: "TRAINER_PROFILE_NOT_LINKED", message: "Your Academic trainer profile isn't linked to your HR employee record. Ask HR or the Academic Head to fix the link, then try again." },
  not_trainer: { code: "NOT_TRAINER", message: "Only trainers with an Academic trainer profile can connect a Google Meet account." },
};

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
