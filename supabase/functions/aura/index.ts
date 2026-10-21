// POST /functions/v1/aura — the ONLY write path for Aura Points (deploy with --no-verify-jwt;
// the caller is identified by their ERP session token, x-erp-session, exactly like Jarvis /
// Live Classes). Every request re-reads the caller from HR, so role / department changes and
// exits apply immediately. Nothing role-related from the browser is trusted.
//
//   {action:"scope"}                                   what I may do + who I may reward
//   {action:"award", recipient_id, points, reason, note?, idempotency_key}
//   {action:"select_best", employee_id, period_start, period_end, period_label?, notes?}
//   {action:"reverse", transaction_id, reason}         Manager-tier / HR admin; keeps the row
//   {action:"deduct", recipient_id, points, reason, idempotency_key}   confidential deduction
//   {action:"statement", employee_id?, month?}         one person's entries (+ net, rank) —
//                                                      deductions ONLY for permitted viewers
//   {action:"leaderboard", month?, department?}        monthly NET ranking (no deduction detail)
//   {action:"feed", limit?}                            public awards feed (never deductions)
//   {action:"totals", from?, to?}                      dashboard: net per employee in period
//
// Deductions (kind 'deduction', negative points) are CONFIDENTIAL: the browser key cannot read
// them (RLS, 20261105) — only this function returns them, and only to the employee themself,
// their head (own team, below them), the HR manager and leadership. Founders / leadership
// (manager tier) never hold Aura: nothing can be awarded to or deducted from them and they
// never appear on the leaderboard. Months are Asia/Kolkata calendar months.
//
// Authority (effective ERP access — hrAccessRole rules, server-side):
//   manager             System Role manager/founder/co_founder/managing_director/director or a
//                       management account → every department, 10/20/50/100
//   operational_manager head-level access whose designation is Operations Manager, or who has
//                       extra departments in hr_employees.managed_divisions → own division +
//                       every managed division, 10/20/50
//   head                head-level access (academic_head / media_head / hr_admin / Sales head)
//                       → own division only, 10/20/50
//   Department = hr_employees.division (no cross-department exceptions).
//   Non-managers can only reward people BELOW their own level; nobody can reward themselves.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { authorizedDivisions, clean, deductEligibility, deductPoints, DIV, eligibility, holdsAura, POINTS, seesPrivate, tierOf, type Row } from "../_shared/aura/rules.ts";

function cors(req: Request) {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-erp-session",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const out = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

interface Ctx { auth: JarvisAuthContext; me: Row; tier: string; emps: Row[]; desig: Row[]; canSelectBest: boolean; hrAdmin: boolean }

async function context(req: Request): Promise<Ctx> {
  const auth = await resolveAuthContext(req);
  const db = adminClient();
  // Only the columns the rules need — never select("*"): hr_employees carries base64 photos
  // (~1 MB for the whole company), which made every Aura call slow.
  const cols = "id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email,photo_url";
  const [empR, desR, rosR] = await Promise.all([
    (async (): Promise<{ data: Row[] | null; error: { message: string } | null }> => {
      const r = await db.from("hr_employees").select(cols + ",managed_divisions");
      if (r.error && /managed_divisions/i.test(r.error.message)) return await db.from("hr_employees").select(cols) as unknown as { data: Row[] | null; error: { message: string } | null };
      return r as unknown as { data: Row[] | null; error: { message: string } | null };
    })(),
    db.from("hr_designations").select("name,access_role,active"),
    db.from("user_roster").select("role").ilike("email", auth.email.replace(/[\\%_]/g, (c) => "\\" + c)).limit(1),
  ]);
  if (empR.error) throw new Error(empR.error.message);
  const emps = (empR.data || []) as Row[];
  const desig = (desR.data || []) as Row[];
  const me = emps.find((e) => e.id === auth.employeeId);
  if (!me) throw new JarvisAuthError(403, "FORBIDDEN", "Your sign-in is not linked to an employee record.");
  const tier = tierOf(me, desig);
  const hrAdmin = lc(me.system_role) === "hr_admin" || lc(rosR.data?.[0]?.role) === "admin";
  const canSelectBest = tier === "manager" || hrAdmin || auth.permissions.includes("hr.payroll");
  return { auth, me, tier, emps, desig, canSelectBest, hrAdmin };
}

const TIER_LABEL: Record<string, string> = { manager: "Manager", operational_manager: "Operations Manager", head: "Department Head", employee: "Employee" };
function roleLabel(c: Ctx): string {
  const d = clean(c.me.designation);
  if (c.tier === "head" && !d) return "Head of " + (DIV[c.me.division] || c.me.division || "department");
  return d || TIER_LABEL[c.tier] || c.tier;
}

const ymdIst = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s: unknown) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const curMonth = () => ymdIst().slice(0, 7);
/** [start, next-month start) of an IST calendar month, as timestamps for created_at filters. */
function monthBounds(m: string): [string, string] {
  const [y, mo] = m.split("-").map(Number), ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1;
  return [`${m}-01T00:00:00+05:30`, `${ny}-${String(nm).padStart(2, "0")}-01T00:00:00+05:30`];
}
const activeEmp = (e: Row) => !["exited", "inactive"].includes(lc(e.employment_status || "active")) && e.account_type !== "system";
/** Public row shape (what a deduction-blind viewer may get). */
const PUBLIC_COLS = "id,recipient_employee_id,recipient_name,recipient_department,awarded_by_name,awarder_role_snapshot,kind,points,reason,note,status,reversed_by,reversed_at,reversal_reason,created_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let c: Ctx;
  try { c = await context(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[aura] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();
  const actorName = c.me.full_name || c.auth.name;
  // Monthly NET ranking: every active employee who holds Aura (founders / leadership excluded),
  // net = awards − deductions in that IST month (may be negative, never clamped). Standard
  // competition ranking: equal net → equal rank. People with no activity rank at net 0.
  async function leaderboard(month: string) {
    const [a, b] = monthBounds(month);
    const r = await db.from("aura_point_transactions").select("recipient_employee_id,points").eq("status", "active").gte("created_at", a).lt("created_at", b).limit(50000);
    if (r.error) throw new Error(r.error.message);
    const net: Record<string, number> = {};
    ((r.data || []) as Row[]).forEach((x) => { net[x.recipient_employee_id] = (net[x.recipient_employee_id] || 0) + Number(x.points || 0); });
    const rows = c.emps.filter((e) => activeEmp(e) && holdsAura(e, c.desig))
      .map((e) => ({ id: e.id, name: e.full_name, division: e.division || null, department: DIV[e.division] || e.division || "", designation: clean(e.designation) || "", photo_url: e.photo_url || null, net: net[e.id] || 0, rank: 0 }))
      .sort((x, y) => y.net - x.net || String(x.name).localeCompare(String(y.name)));
    let prev: number | null = null, pos = 0;
    rows.forEach((x, i) => { if (x.net !== prev) { pos = i + 1; prev = x.net; } x.rank = pos; });
    return { rows, active: Object.keys(net).length > 0 };
  }

  try {
    switch (body.action) {
      case "scope": {
        const eligible = c.tier === "employee" ? [] : c.emps
          .filter((t) => !eligibility(c, t))
          .map((t) => ({ id: t.id, name: t.full_name, division: t.division, department: DIV[t.division] || t.division || "", designation: clean(t.designation) || "", photo_url: t.photo_url || null, aura: 0, month: 0 }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        // Current Aura for exactly these people in ONE query (no per-employee lookups).
        if (eligible.length) {
          const byId: Record<string, Row> = {}; eligible.forEach((x) => { byId[x.id] = x; });
          const monthStart = ymdIst().slice(0, 8) + "01";
          const tx = await db.from("aura_point_transactions").select("recipient_employee_id,points,created_at")
            .eq("status", "active").in("recipient_employee_id", eligible.map((x) => x.id)).limit(20000);
          (tx.data || []).forEach((t: Row) => {
            const x = byId[t.recipient_employee_id]; if (!x) return;
            const p = Number(t.points || 0); x.aura += p;
            if (ymdIst(new Date(t.created_at)) >= monthStart) x.month += p;
          });
        }
        const dPts = deductPoints(c);
        const deductable = dPts.length ? c.emps.filter((t) => !deductEligibility(c, t))
          .map((t) => ({ id: t.id, name: t.full_name, division: t.division, department: DIV[t.division] || t.division || "", designation: clean(t.designation) || "", photo_url: t.photo_url || null }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
        return out(req, 200, {
          earns: holdsAura(c.me, c.desig), view_all: c.tier === "manager" || c.hrAdmin,
          deduct_points: dPts, can_deduct: deductable.length > 0, deductable,
          me: { id: c.me.id, name: actorName, division: c.me.division },
          tier: c.tier, points: POINTS[c.tier] || [], can_award: c.tier !== "employee" && eligible.length > 0,
          scope: (() => { const a = authorizedDivisions(c.me, c.tier); return a === "*" ? "organisation" : a.length ? a.map((d) => DIV[d] || d).join(" + ") : "none"; })(),
          departments: authorizedDivisions(c.me, c.tier),
          // What this person may SEE on the Aura dashboard / history (HR + Best Employee pickers: all).
          view_departments: c.tier === "manager" || c.hrAdmin || c.canSelectBest ? "*" : authorizedDivisions(c.me, c.tier),
          role_label: roleLabel(c),
          can_select_best: c.canSelectBest, can_reverse: c.tier === "manager" || c.hrAdmin, eligible,
        });
      }

      case "award": {
        const pts = Number(body.points), reason = String(body.reason || "").trim().slice(0, 300), note = String(body.note || "").trim().slice(0, 600) || null;
        const key = String(body.idempotency_key || "").slice(0, 80);
        if (!key) return out(req, 400, { error: "Missing request id." });
        if (!(POINTS[c.tier] || []).includes(pts)) return out(req, 403, { error: c.tier === "employee" ? "Your role can't give Aura Points." : `You can give ${POINTS[c.tier].join(" / ")} Aura Points per award.` });
        if (!reason) return out(req, 400, { error: "A reason is required." });
        const t = c.emps.find((e) => e.id === body.recipient_id);
        const why = eligibility(c, t);
        if (why) return out(req, 403, { error: why });
        // Idempotent: the same dialog submission (same key) never creates a second award.
        const prev = await db.from("aura_point_transactions").select("*").eq("awarded_by_employee_id", c.me.id).eq("idempotency_key", key).maybeSingle();
        if (prev.data) return out(req, 200, { ok: true, duplicate: true, transaction: prev.data });
        const role = c.tier + (c.me.designation ? ` · ${clean(c.me.designation)}` : "");
        const allowed = authorizedDivisions(c.me, c.tier);
        const scopeSnap = allowed === "*" ? ["*"] : allowed;
        const row: Row = {
          recipient_employee_id: t!.id, recipient_name: t!.full_name, recipient_department: t!.division || null,
          awarded_by_employee_id: c.me.id, awarded_by_name: actorName, awarder_role_snapshot: role, awarder_scope: scopeSnap,
          kind: "award", points: pts, reason, note, idempotency_key: key,
        };
        let ins = await db.from("aura_point_transactions").insert(row).select("*").single();
        if (ins.error && /awarder_scope/i.test(ins.error.message)) {   // 20261028 not run yet
          delete row.awarder_scope;
          ins = await db.from("aura_point_transactions").insert(row).select("*").single();
        }
        if (ins.error) {
          if (/uq_aura_idem|duplicate key/i.test(ins.error.message)) {
            const again = await db.from("aura_point_transactions").select("*").eq("awarded_by_employee_id", c.me.id).eq("idempotency_key", key).maybeSingle();
            return out(req, 200, { ok: true, duplicate: true, transaction: again.data });
          }
          throw new Error(ins.error.message);
        }
        const tx = ins.data as Row;
        // Notification Center (one per award) + audit trail.
        if (t!.portal_email) {
          await db.from("erp_notifications").upsert({
            recipient_email: lc(t!.portal_email), recipient_employee_id: t!.id, type: "aura_award",
            title: `+${pts} Aura Points from ${actorName}`, message: reason,
            entity_type: "aura_point_transaction", entity_id: tx.id, dedupe_key: "aura:" + tx.id, link: "aura:" + tx.id,
            metadata: { points: pts, reason, awarded_by: actorName, awarded_by_role: roleLabel(c) },
          }, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, () => {});
        }
        await db.from("hr_audit_log").insert({ actor_email: c.auth.email, actor_name: actorName, action: "aura_awarded", entity: "aura", entity_id: tx.id,
          reason, meta: { recipient: t!.full_name, recipient_id: t!.id, department: t!.division || null, points: pts, note, tier: c.tier, role: roleLabel(c), scope: scopeSnap } }).then(() => {}, () => {});
        return out(req, 200, { ok: true, transaction: tx });
      }

      case "deduct": {
        const pts = Number(body.points), reason = String(body.reason || "").trim().slice(0, 300);
        const key = String(body.idempotency_key || "").slice(0, 80);
        if (!key) return out(req, 400, { error: "Missing request id." });
        const allowedPts = deductPoints(c);
        if (!allowedPts.length) return out(req, 403, { error: "Your role can't deduct Aura Points." });
        if (!allowedPts.includes(pts)) return out(req, 403, { error: `You can deduct ${allowedPts.join(" / ")} Aura Points at a time.` });
        if (!reason) return out(req, 400, { error: "A reason is required." });
        const t = c.emps.find((e) => e.id === body.recipient_id);
        const why = deductEligibility(c, t);
        if (why) return out(req, 403, { error: why });
        const prev = await db.from("aura_point_transactions").select("*").eq("awarded_by_employee_id", c.me.id).eq("idempotency_key", key).maybeSingle();
        if (prev.data) return out(req, 200, { ok: true, duplicate: true, transaction: prev.data });
        const allowed = authorizedDivisions(c.me, c.tier);
        const row: Row = {
          recipient_employee_id: t!.id, recipient_name: t!.full_name, recipient_department: t!.division || null,
          awarded_by_employee_id: c.me.id, awarded_by_name: actorName, awarder_role_snapshot: (c.hrAdmin && c.tier !== "manager" ? "hr_manager" : c.tier) + (c.me.designation ? ` · ${clean(c.me.designation)}` : ""),
          awarder_scope: c.tier === "manager" || c.hrAdmin ? ["*"] : (allowed === "*" ? ["*"] : allowed),
          kind: "deduction", points: -pts, reason, idempotency_key: key,
        };
        let ins = await db.from("aura_point_transactions").insert(row).select("*").single();
        if (ins.error && /awarder_scope/i.test(ins.error.message)) { delete row.awarder_scope; ins = await db.from("aura_point_transactions").insert(row).select("*").single(); }
        if (ins.error) {
          if (/aura_point_transactions_kind_check|kind/i.test(ins.error.message)) return out(req, 503, { error: "Deductions need the database update 20261105_aura_deductions.sql." });
          if (/uq_aura_idem|duplicate key/i.test(ins.error.message)) {
            const again = await db.from("aura_point_transactions").select("*").eq("awarded_by_employee_id", c.me.id).eq("idempotency_key", key).maybeSingle();
            return out(req, 200, { ok: true, duplicate: true, transaction: again.data });
          }
          throw new Error(ins.error.message);
        }
        const tx = ins.data as Row;
        // Private notification to the affected employee ONLY. erp_notifications is readable by the
        // browser key, so it carries no points and no reason — the bell opens the statement, which
        // this function serves only to permitted viewers.
        if (t!.portal_email) {
          await db.from("erp_notifications").upsert({
            recipient_email: lc(t!.portal_email), recipient_employee_id: t!.id, type: "aura_update",
            title: "Aura Points update", message: "Open your Aura statement to see the details.",
            entity_type: "aura_point_transaction", entity_id: tx.id, dedupe_key: "aura:" + tx.id, link: "aura:" + tx.id, metadata: {},
          }, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, () => {});
        }
        // Audit trail: hr_audit_log is browser-readable too → reference only; the deduction row
        // itself (immutable, who / when / why) is the confidential record.
        await db.from("hr_audit_log").insert({ actor_email: c.auth.email, actor_name: actorName, action: "aura_deducted", entity: "aura", entity_id: tx.id,
          meta: { recipient_id: t!.id } }).then(() => {}, () => {});
        return out(req, 200, { ok: true, transaction: tx });
      }

      case "statement": {
        const t = body.employee_id ? c.emps.find((e) => e.id === body.employee_id) : c.me;
        if (!t) return out(req, 404, { error: "That employee was not found." });
        const full = seesPrivate(c, t);
        const month = isMonth(body.month) ? body.month : body.month === "all" ? "all" : curMonth();
        let q = db.from("aura_point_transactions").select(PUBLIC_COLS).eq("recipient_employee_id", t.id).order("created_at", { ascending: false }).limit(1000);
        if (!full) q = q.neq("kind", "deduction");   // filtered HERE, never in the browser
        if (month !== "all") { const [a, b] = monthBounds(month); q = q.gte("created_at", a).lt("created_at", b); }
        const r = await q;
        if (r.error) throw new Error(r.error.message);
        const earns = holdsAura(t, c.desig);
        const lb = earns ? await leaderboard(month === "all" ? curMonth() : month) : null;
        const mine = lb?.rows.find((x) => x.id === t.id);
        return out(req, 200, {
          employee: { id: t.id, name: t.full_name, division: t.division || null, department: DIV[t.division] || t.division || "", designation: clean(t.designation) || "", photo_url: t.photo_url || null },
          earns, full, month: month === "all" ? curMonth() : month,
          month_net: mine ? mine.net : 0, rank: mine ? mine.rank : null, ranked: lb ? lb.rows.length : 0,
          rows: r.data || [],
        });
      }

      case "leaderboard": {
        const month = isMonth(body.month) ? body.month : curMonth();
        const lb = await leaderboard(month);
        const dept = String(body.department || "");
        const rows = dept ? lb.rows.filter((x) => x.division === dept) : lb.rows;
        return out(req, 200, { month, rows, active: lb.active, departments: [...new Set(lb.rows.map((x) => x.division).filter(Boolean))].map((d) => ({ code: d, name: DIV[d as string] || d })) });
      }

      case "feed": {
        const lim = Math.min(50, Math.max(1, Number(body.limit) || 20));
        const r = await db.from("aura_point_transactions").select("id,recipient_employee_id,recipient_name,awarded_by_name,points,reason,created_at").eq("kind", "award").eq("status", "active").order("created_at", { ascending: false }).limit(lim);
        if (r.error) throw new Error(r.error.message);
        return out(req, 200, { items: r.data || [] });
      }

      case "totals": {   // dashboard: NET per visible employee (period + lifetime) + award count
        const from = isDate(body.from) ? body.from + "T00:00:00+05:30" : null, to = isDate(body.to) ? body.to + "T23:59:59.999+05:30" : null;
        // Only NETS (public: they are the leaderboard figure) and AWARD counts leave this function.
        const all: Row[] = []; let off = 0;
        for (;;) {
          const r = await db.from("aura_point_transactions").select("recipient_employee_id,points,kind,created_at").eq("status", "active").range(off, off + 999);
          if (r.error) throw new Error(r.error.message);
          all.push(...((r.data || []) as Row[])); if ((r.data || []).length < 1000) break; off += 1000;
        }
        const fa = from ? Date.parse(from) : -Infinity, tb = to ? Date.parse(to) : Infinity;
        const by: Record<string, Row> = {};
        all.forEach((x) => {
          const o = by[x.recipient_employee_id] || (by[x.recipient_employee_id] = { life: 0, per: 0, n: 0, last: "" });
          const p = Number(x.points || 0), ts = Date.parse(x.created_at); o.life += p;
          if (ts < fa || ts > tb) return;
          o.per += p; if (x.kind === "award") o.n++;   // award COUNT only — never a deduction count
          const d = ymdIst(new Date(ts)); if (d > o.last) o.last = d;
        });
        return out(req, 200, { by, no_aura: c.emps.filter((e) => !holdsAura(e, c.desig)).map((e) => e.id) });
      }

      case "select_best": {
        if (!c.canSelectBest) return out(req, 403, { error: "Only HR or a Manager can select the Best Employee." });
        const ps = body.period_start, pe = body.period_end;
        if (!isDate(ps) || !isDate(pe) || pe < ps) return out(req, 400, { error: "Choose a valid period." });
        const t = c.emps.find((e) => e.id === body.employee_id);
        if (!t || ["exited", "inactive"].includes(lc(t.employment_status || "active"))) return out(req, 400, { error: "That employee is not active." });
        // Points recomputed on the server for the period (Asia/Kolkata calendar days).
        const tx = await db.from("aura_point_transactions").select("points").eq("recipient_employee_id", t.id).eq("status", "active")
          .gte("created_at", ps + "T00:00:00+05:30").lte("created_at", pe + "T23:59:59.999+05:30");
        const total = (tx.data || []).reduce((s: number, r: Row) => s + Number(r.points || 0), 0);
        await db.from("best_employee_selections").update({ status: "superseded" }).eq("period_start", ps).eq("period_end", pe).eq("status", "active");
        const ins = await db.from("best_employee_selections").insert({
          employee_id: t.id, employee_name: t.full_name, department: t.division || null, period_start: ps, period_end: pe,
          period_label: String(body.period_label || "").slice(0, 60) || null, aura_points_during_period: total,
          selected_by_employee_id: c.me.id, selected_by_name: actorName, notes: String(body.notes || "").slice(0, 600) || null,
        }).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        if (t.portal_email) {
          await db.from("erp_notifications").upsert({
            recipient_email: lc(t.portal_email), recipient_employee_id: t.id, type: "best_employee",
            title: "You were selected as Best Employee", message: `${body.period_label || ps + " – " + pe} · ${total} Aura Points. Congratulations!`,
            entity_type: "best_employee_selection", entity_id: ins.data.id, dedupe_key: "best:" + ins.data.id, link: "aura:best",
          }, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, () => {});
        }
        await db.from("hr_audit_log").insert({ actor_email: c.auth.email, actor_name: actorName, action: "best_employee_selected", entity: "aura", entity_id: ins.data.id,
          reason: body.period_label || null, meta: { employee: t.full_name, period_start: ps, period_end: pe, points: total } }).then(() => {}, () => {});
        return out(req, 200, { ok: true, selection: ins.data });
      }

      case "reverse": {
        if (!(c.tier === "manager" || c.hrAdmin)) return out(req, 403, { error: "Only a Manager or HR admin can reverse an award." });
        const why = String(body.reason || "").trim();
        if (!why) return out(req, 400, { error: "A reason is required." });
        const u = await db.from("aura_point_transactions").update({ status: "reversed", reversed_by: actorName, reversed_at: new Date().toISOString(), reversal_reason: why.slice(0, 300) })
          .eq("id", body.transaction_id).eq("status", "active").select("*");
        if (u.error) throw new Error(u.error.message);
        if (!u.data?.length) return out(req, 409, { error: "That award is already reversed or doesn't exist." });
        await db.from("hr_audit_log").insert({ actor_email: c.auth.email, actor_name: actorName, action: "aura_reversed", entity: "aura", entity_id: body.transaction_id, reason: why }).then(() => {}, () => {});
        return out(req, 200, { ok: true, transaction: u.data[0] });
      }
    }
    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("[aura]", body.action, e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /aura_point_transactions|best_employee_selections|relation|schema cache/i.test(e.message)
      ? "Aura Points needs the database update 20261027_aura_points.sql." : "Something went wrong. Please try again.";
    return out(req, 500, { error: msg });
  }
});
