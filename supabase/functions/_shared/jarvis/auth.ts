// Who is calling Jarvis — resolved ONLY on the server:
//   1. The browser sends a Supabase Auth access token (email OTP / magic-link sign-in).
//   2. The token is verified with Supabase Auth (signature + expiry) → verified email.
//   3. Access comes from that person's live hr_employees record (System Role, account type,
//      designation, employment status) — the same rules the ERP portals use. Nothing the
//      browser sends about roles is read.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { config } from "./config.ts";

export type JarvisScope = "org" | "academic" | "trainer";

export interface JarvisAuthContext {
  authUserId: string;
  email: string;
  employeeId: string;
  name: string;
  /** Resolved access role, e.g. co_founder | manager | academic_head | trainer | system */
  role: string;
  /** What the person may read through Jarvis. */
  scope: JarvisScope;
  /** trainers.id when the person is also a trainer (used to scope "my classes"). */
  trainerId: string | null;
  division: string | null;
}

export class JarvisAuthError extends Error {
  constructor(public status: 401 | 403, message: string) { super(message); }
}

const LEADERSHIP = ["manager", "founder", "co_founder", "managing_director", "director"];
const HEAD_DESIGNATIONS = ["academic head", "class coordinator", "operations manager"];

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

export async function resolveAuthContext(req: Request): Promise<JarvisAuthContext> {
  const h = req.headers.get("authorization") || "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new JarvisAuthError(401, "Sign in to use Jarvis.");
  const sb = adminClient();
  const { data, error } = await sb.auth.getUser(token);
  const user = data?.user;
  if (error || !user || !user.email) throw new JarvisAuthError(401, "Your Jarvis sign-in has expired. Please sign in again.");
  if (user.is_anonymous) throw new JarvisAuthError(401, "Sign in with your work email to use Jarvis.");
  const email = user.email.trim().toLowerCase();

  const { data: rows, error: e2 } = await sb.from("hr_employees")
    .select("id,full_name,portal_email,division,department,designation,system_role,account_type,employment_status")
    .eq("portal_email", email);
  if (e2) throw new JarvisAuthError(403, "Your ERP access could not be checked right now.");
  const active = (rows || []).filter((r) => !["inactive", "exited"].includes(String(r.employment_status || "active").toLowerCase()));
  // Prefer the leadership row when a login has duplicates (same rule as manager.html).
  const rec = active.find((r) => r.account_type === "management" || LEADERSHIP.includes(String(r.system_role || "").toLowerCase())) || active[0];
  if (!rec) throw new JarvisAuthError(403, "This email is not linked to an active ERP employee.");

  const sys = String(rec.system_role || "").toLowerCase();
  const desig = String(rec.designation || "").trim().replace(/^(senior|mid-level|junior)\s+/i, "").toLowerCase();
  let role = sys || desig || "employee";
  let scope: JarvisScope | null = null;
  if (LEADERSHIP.includes(sys) || rec.account_type === "management" || rec.account_type === "system") {
    scope = "org"; role = sys || (rec.account_type === "system" ? "system" : "management");
  } else if (sys === "academic_head" || (!sys && HEAD_DESIGNATIONS.includes(desig))) {
    scope = "academic"; role = "academic_head";
  } else if (sys === "trainer" || (rec.division === "education" && (!sys || sys === "trainer"))) {
    scope = "trainer"; role = "trainer";
  }
  if (!scope) throw new JarvisAuthError(403, "Jarvis is available to management and academic staff only.");

  let trainerId: string | null = null;
  const t = await sb.from("trainers").select("id").or(`hr_employee_id.eq.${rec.id},portal_email.eq.${email}`).limit(1);
  if (t.data && t.data[0]) trainerId = t.data[0].id;

  return { authUserId: user.id, email, employeeId: rec.id, name: rec.full_name || email, role, scope, trainerId, division: rec.division || null };
}
