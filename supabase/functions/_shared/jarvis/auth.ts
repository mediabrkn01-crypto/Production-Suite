// Who is calling Jarvis — resolved ONLY on the server, from the existing ERP sign-in:
//   1. The ERP login (index.html) gets a signed session token from `erp-session` after the
//      normal username/password check. The browser sends it as `x-erp-session`.
//   2. The token's signature + expiry are verified here → signed-in email.
//   3. The live hr_employees + user_roster records give identity and EFFECTIVE ACCESS using the
//      same rules as the ERP (common.js hrAccessRole: System Role → designation default access
//      → legacy team roles; HR admin via roster role 'admin' / system role hr_admin; Sales head
//      via head/manager title, as sales.html). Re-read on every request, so role changes,
//      deactivation and exits apply immediately. Nothing role-related from the browser is read.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { config } from "./config.ts";
import { verifySession } from "./session.ts";

/** What a person may read through Jarvis. */
export type Permission =
  | "self"            // own tasks, attendance, leave
  | "academic.all"    // every Academic class / batch / trainer leave
  | "academic.own"    // own classes only (trainers)
  | "hr.attendance"   // company attendance + leave
  | "sales.all"       // whole Sales team + CRM
  | "sales.own"       // own leads / enrolments only (counselors)
  | "media.all"       // Media pipeline + work overview
  | "org";            // organisation-wide metrics

export interface JarvisAuthContext {
  /** Kept for audit/memory keys — this is the employee id (there are no separate Jarvis users). */
  authUserId: string;
  employeeId: string;
  email: string;
  name: string;
  department: string | null;
  designation: string | null;
  /** Effective access role, same vocabulary as the ERP (co_founder, academic_head, trainer, hr_admin, sales, media_head, '' = employee…) */
  role: string;
  permissions: Permission[];
  /** trainers.id when the person teaches (scopes "my classes"). */
  trainerId: string | null;
}

export class JarvisAuthError extends Error {
  constructor(public status: 401 | 403, public code: "SESSION_EXPIRED" | "FORBIDDEN", message: string) { super(message); }
}

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again to continue using Jarvis.";

const LEADERSHIP = ["manager", "founder", "co_founder", "managing_director", "director"];
const ACCESS_DEFAULTS: Record<string, string> = {
  "academic head": "academic_head", "class coordinator": "academic_head", "operations manager": "academic_head", "fluency coach": "trainer",
};

let _admin: SupabaseClient | null = null;
/** Service-role client for server-side reads. Never exposed to the browser. */
export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(config.erpApiBase, config.erpApiToken, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-client-info": "jarvis-edge/1" } },
    });
  }
  return _admin;
}

const likeExact = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
const clean = (s: unknown) => String(s ?? "").trim().replace(/^(senior|mid-level|junior)\s+/i, "");

export async function resolveAuthContext(req: Request): Promise<JarvisAuthContext> {
  const session = await verifySession(req.headers.get("x-erp-session"));
  if (!session) throw new JarvisAuthError(401, "SESSION_EXPIRED", SESSION_EXPIRED_MESSAGE);
  const email = session.email;
  const sb = adminClient();

  const [empR, rosterR, desigR] = await Promise.all([
    sb.from("hr_employees").select("id,full_name,portal_email,division,department,designation,system_role,account_type,employment_status,portal_access_enabled").ilike("portal_email", likeExact(email)),
    sb.from("user_roster").select("role,name").ilike("email", likeExact(email)).limit(1),
    sb.from("hr_designations").select("name,access_role,active"),
  ]);
  if (empR.error) throw new JarvisAuthError(401, "SESSION_EXPIRED", "Your ERP access could not be checked right now.");
  // Same row preference as the ERP access gate (portal_access_state): system → active → enabled.
  const rows = (empR.data || []).sort((a, b) =>
    Number(b.account_type === "system") - Number(a.account_type === "system") ||
    Number(String(b.employment_status || "active").toLowerCase() === "active") - Number(String(a.employment_status || "active").toLowerCase() === "active") ||
    Number(b.portal_access_enabled !== false) - Number(a.portal_access_enabled !== false));
  const rec = rows[0];
  if (!rec) throw new JarvisAuthError(403, "FORBIDDEN", "This sign-in is not linked to an employee record.");
  const status = String(rec.employment_status || "active").toLowerCase();
  if (rec.account_type !== "system" && (status === "exited" || status === "inactive" || rec.portal_access_enabled === false)) {
    throw new JarvisAuthError(401, "SESSION_EXPIRED", "Your ERP access is disabled. Contact HR.");
  }

  // Effective access role — common.js hrAccessRole, server-side.
  const sys = String(rec.system_role || "").toLowerCase();
  const desig = clean(rec.designation);
  const desigAccess = (() => {
    const hit = (desigR.data || []).find((d) => d.active !== false && String(d.name).toLowerCase() === desig.toLowerCase());
    return (hit && hit.access_role) || ACCESS_DEFAULTS[desig.toLowerCase()] || "";
  })();
  const teamRoles = String(rec.department || "").split(",").map((r) => clean(r));
  let role = sys || desigAccess;
  if (!role && teamRoles.some((r) => /^(academic head|class coordinator|operations manager)$/i.test(r))) role = "academic_head";
  if (!role && rec.division === "education" && teamRoles.some((r) => /coach|trainer/i.test(r))) role = "trainer";
  const rosterRole = String(rosterR.data?.[0]?.role || "").toLowerCase();
  const isLeader = LEADERSHIP.includes(sys) || rec.account_type === "management" || rec.account_type === "system";
  if (isLeader && !role) role = rec.account_type === "system" ? "system" : "management";

  // Permissions from effective access (never from the browser).
  const p = new Set<Permission>(["self"]);
  if (isLeader) ["org", "academic.all", "hr.attendance", "sales.all", "media.all"].forEach((x) => p.add(x as Permission));
  if (role === "academic_head") p.add("academic.all");
  if (role === "trainer" || (rec.division === "education" && !p.has("academic.all"))) p.add("academic.own");
  if (role === "hr_admin" || rosterRole === "admin" || rec.division === "hr") p.add("hr.attendance");
  if (rec.division === "sales" || role === "sales") {
    // sales.html: head = global manager or a head/manager title.
    p.add(/head|manager/i.test(`${rec.department || ""} ${rec.designation || ""}`) ? "sales.all" : "sales.own");
  }
  if (role === "media_head") p.add("media.all");

  let trainerId: string | null = null;
  if (p.has("academic.own") || p.has("academic.all")) {
    const t = await sb.from("trainers").select("id").or(`hr_employee_id.eq.${rec.id},portal_email.eq.${email}`).limit(1);
    if (t.data && t.data[0]) trainerId = t.data[0].id;
  }

  return {
    authUserId: rec.id, employeeId: rec.id, email, name: rec.full_name || email,
    department: rec.division || null, designation: desig || null, role: role || "employee",
    permissions: [...p], trainerId,
  };
}

export const can = (a: JarvisAuthContext, perm: Permission) => a.permissions.includes(perm);
