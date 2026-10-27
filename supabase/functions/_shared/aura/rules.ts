// Aura Points authorization rules — pure functions shared by the `aura` edge function and its
// tests. Authority comes from the ERP's effective access (System Role → designation default
// access via hr_designations → management account), never from the browser.
// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export const LEADERSHIP = ["manager", "founder", "co_founder", "managing_director", "director"];
export const HEAD_ROLES = ["academic_head", "media_head", "hr_admin"];
export const DESIG_DEFAULTS: Record<string, string> = {
  "academic head": "academic_head", "class coordinator": "academic_head", "operations manager": "academic_head", "fluency coach": "trainer",
};
export const POINTS: Record<string, number[]> = { manager: [10, 20, 50, 100], operational_manager: [10, 20, 50], head: [10, 20, 50] };
export const RANK: Record<string, number> = { manager: 3, operational_manager: 2, head: 1, employee: 0 };
export const DIV: Record<string, string> = { education: "Academics", production: "Media / Production", sales: "Sales", hr: "HR", accounts: "Accounts", management: "Management", other: "Administration" };


const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
export const clean = (s: unknown) => String(s ?? "").trim().replace(/^(senior|mid-level|junior)\s+/i, "");

/** Effective Aura tier of ANY employee row (same rules for caller and target). */
export function tierOf(e: Row, desig: Row[]): string {
  const sys = lc(e.system_role);
  if (LEADERSHIP.includes(sys) || e.account_type === "management") return "manager";
  const d = clean(e.designation), dl = d.toLowerCase();
  const hit = desig.find((x) => x.active !== false && lc(x.name) === dl);
  const access = sys || (hit && hit.access_role) || DESIG_DEFAULTS[dl] || "";
  const salesHead = e.division === "sales" && /head|manager/i.test(`${e.department || ""} ${e.designation || ""}`);
  if (HEAD_ROLES.includes(access) || salesHead) {
    // Operations-Manager level: the designation, or HR has assigned departments beyond their own.
    const extra = managedDivisions(e).filter((x) => x !== e.division);
    return /operations?\s*manager/i.test(d) || extra.length ? "operational_manager" : "head";
  }
  return "employee";
}

/** hr_employees.managed_divisions (20261028) as a clean list of codes. */
export function managedDivisions(e: Row): string[] {
  const v = e && e.managed_divisions;
  return (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean);
}

/** Departments the caller may award in: "*" = organisation-wide. */
export function authorizedDivisions(e: Row, tier: string): "*" | string[] {
  if (tier === "manager") return "*";
  if (tier === "employee") return [];
  const own = e.division ? [String(e.division)] : [];
  if (tier === "head") return own;                                       // Department Head: own department only
  return [...new Set([...own, ...managedDivisions(e)])];                 // Operations Manager: all assigned
}

/** WORK ASSIGNMENT ONLY — departments whose people this caller may ASSIGN work to. Leadership,
 *  HR admin, Operations Managers and every Department Head may assign to anyone in the
 *  organisation; normal employees to no one. This grants the assign action only: what a caller
 *  may SEE of other departments still follows authorizedDivisions(). */
export const ASSIGN_ANYWHERE_TIERS = ["manager", "operational_manager", "head"];
export function assignableDivisions(tier: string, hrAdmin = false): "*" | string[] {
  return hrAdmin || ASSIGN_ANYWHERE_TIERS.includes(tier) ? "*" : [];
}


export interface Caller { me: Row; tier: string; desig: Row[]; hrAdmin?: boolean }

/** Founders / co-founders / leadership (manager tier) never hold Aura Points: they only award,
 *  deduct and view — no balance, no leaderboard, nothing can be given to or taken from them. */
export const holdsAura = (e: Row, desig: Row[]) => tierOf(e, desig) !== "manager" && e.account_type !== "system";

/** Points a caller may DEDUCT per action: leadership + HR manager 10/20/50/100, heads 10/20/50. */
export function deductPoints(c: Caller): number[] {
  if (c.tier === "manager" || c.hrAdmin) return [10, 20, 50, 100];
  return c.tier === "employee" ? [] : [10, 20, 50];
}

/** Can the caller deduct from this employee? Returns a reason when not.
 *  Leadership and the HR manager: any employee who holds Aura (managers included).
 *  Heads / Operations Managers: their own team only — in their department scope and below them. */
export function deductEligibility(c: Caller, t: Row | undefined): string | null {
  if (!t) return "That employee was not found.";
  if (t.id === c.me.id) return "You can't deduct Aura Points from yourself.";
  if (t.account_type === "system") return "That account doesn't hold Aura Points.";
  if (["exited", "inactive"].includes(lc(t.employment_status || "active"))) return "That employee is not active.";
  if (!holdsAura(t, c.desig)) return "Founders don't hold Aura Points.";
  if (c.tier === "manager" || c.hrAdmin) return null;
  if (c.tier === "employee") return "Your role can't deduct Aura Points.";
  const scope = authorizedDivisions(c.me, c.tier);
  if (scope === "*") return null;
  if (!t.division || !scope.includes(String(t.division))) return "You can only deduct from your own team.";
  if (RANK[tierOf(t, c.desig)] >= RANK[c.tier]) return "You can only deduct from people below your level — ask HR or a founder.";
  return null;
}

/** May the caller see this employee's CONFIDENTIAL entries (deductions + their reasons)?
 *  The employee themself, leadership, the HR manager, and the head of their team. */
export function seesPrivate(c: Caller, t: Row | undefined): boolean {
  if (!t) return false;
  if (t.id === c.me.id || c.tier === "manager" || c.hrAdmin) return true;
  if (c.tier === "employee") return false;
  const scope = authorizedDivisions(c.me, c.tier);
  if (scope === "*") return true;
  return !!t.division && scope.includes(String(t.division)) && RANK[tierOf(t, c.desig)] < RANK[c.tier];
}

/** Can the caller reward this employee? Returns a reason when not. */
export function eligibility(c: Caller, t: Row | undefined): string | null {
  if (!t) return "That employee was not found.";
  if (t.id === c.me.id) return "You can't give Aura Points to yourself.";
  if (t.account_type === "system") return "That account can't receive Aura Points.";
  if (!holdsAura(t, c.desig)) return "Founders don't hold Aura Points.";
  if (["exited", "inactive"].includes(lc(t.employment_status || "active"))) return "That employee is not active.";
  const scope = authorizedDivisions(c.me, c.tier);
  if (scope === "*") return null;
  if (!scope.length) return "Your role can't give Aura Points.";
  if (!t.division || !scope.includes(String(t.division))) return "You can only give Aura Points within your assigned department" + (scope.length > 1 ? "s" : "") + ".";
  if (RANK[tierOf(t, c.desig)] >= RANK[c.tier]) return "You can only give Aura Points to people below your level — ask a Manager.";
  return null;
}
