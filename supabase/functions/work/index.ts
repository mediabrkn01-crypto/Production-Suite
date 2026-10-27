// POST /functions/v1/work — server-checked CREATE path for the shared Work Assignment engine
// (work-tasks.js / BEWork). Deploy with --no-verify-jwt; the caller is identified by their ERP
// session token (x-erp-session), like Aura / Calendar / Share. Writes the SAME records every
// suite uses — work_projects (parent) + one `assignments` row per person (+ work_reference_files)
// — so the work shows up exactly where it always does: Media Suite pipeline for Media / Production
// people (scope 'media'), "My Assigned Tasks" for everyone else (scope 'org').
//
//   {action:"scope"}                     what I may assign: org-wide or which departments
//   {action:"create", title, brief?, priority, assigned_date?, project?, shared_files?:[{name,url}],
//    items:[{employee_id, deliverable?, type?, instructions?, due, files?:[{name,url}]}],
//    allow_inactive?}
//       project=true (or 2+ items) → one work_projects parent + one assignment each (deliverable per
//       person). project=false with one item → a plain individual assignment.
//
// Authority (effective ERP access, re-read on every call — never trusted from the browser):
//   HR admin (System Role hr_admin or HR admin login) · leadership (founder / co-founder /
//   director / management account)                → ANY active employee in ANY department
//   Department head / Operations Manager           → ANY active employee in ANY department
//   everyone else                                  → cannot assign
// (assignableDivisions in _shared/aura/rules.ts — assigning only; what a head may SEE of other
// departments still follows authorizedDivisions.)
// HR keeps its HR role — organisation-wide assignment is a permission of HR admin access, not a
// Manager role. Exited / inactive employees can't get new work unless an HR admin or leadership
// sends allow_inactive (the explicit administrative override).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext } from "../_shared/jarvis/auth.ts";
import { assignableDivisions, authorizedDivisions, clean, DIV, tierOf, type Row } from "../_shared/aura/rules.ts";

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
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const ymdIst = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
const PRIO = ["low", "medium", "high", "very_high"];
const fileList = (v: unknown) => (Array.isArray(v) ? v : []).filter((f: Row) => f && /^https?:\/\//i.test(String(f.url || ""))).slice(0, 30)
  .map((f: Row) => ({ name: String(f.name || "Reference").replace(/[|;]/g, " ").slice(0, 160), url: String(f.url).slice(0, 1000), size: Number(f.size) || null, type: f.type ? String(f.type).slice(0, 120) : null }));
const refString = (fs: Row[]) => fs.map((f) => f.name + "|" + f.url).join(";;");
const fmtDue = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let auth;
  try { auth = await resolveAuthContext(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[work] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();

  try {
    const cols = "id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email,photo_url";
    const [er, dr, rr] = await Promise.all([
      (async () => { const r = await db.from("hr_employees").select(cols + ",managed_divisions"); return r.error && /managed_divisions/i.test(r.error.message) ? await db.from("hr_employees").select(cols) : r; })(),
      db.from("hr_designations").select("name,access_role,active"),
      db.from("user_roster").select("role").ilike("email", auth.email.replace(/[\\%_]/g, (c) => "\\" + c)).limit(1),
    ]);
    if (er.error) throw new Error(er.error.message);
    const emps = (er.data || []) as unknown as Row[], desig = (dr.data || []) as Row[];
    const me = emps.find((e) => e.id === auth.employeeId);
    if (!me) return out(req, 403, { error: "Your sign-in is not linked to an employee record." });
    const tier = tierOf(me, desig);
    const hrAdmin = lc(me.system_role) === "hr_admin" || lc((rr.data as Row[] | null)?.[0]?.role) === "admin";
    const orgWide = tier === "manager" || hrAdmin;
    const ad = authorizedDivisions(me, tier);
    const depts: "*" | string[] = orgWide || ad === "*" ? "*" : ad;      // what the caller manages / sees
    const assignTo = assignableDivisions(tier, hrAdmin);                    // who the caller may assign work to
    const canOverride = orgWide;
    const actor = me.full_name || auth.name;
    const actorRole = hrAdmin && tier !== "manager" ? "HR" : clean(me.designation) || "Your manager";
    const active = (e: Row) => !["exited", "inactive", "disabled", "terminated", "suspended"].includes(lc(e.employment_status || "active"));
    const inScope = (e: Row) => assignTo === "*" || (!!e.division && assignTo.includes(String(e.division)));

    if (body.action === "scope") {
      return out(req, 200, {
        org_wide: orgWide, departments: depts, assign_departments: assignTo, can_assign: assignTo === "*" || assignTo.length > 0, can_override: canOverride,
        role: hrAdmin && tier !== "manager" ? "hr" : tier,
      });
    }

    if (body.action === "create") {
      if (assignTo !== "*" && !assignTo.length) return out(req, 403, { error: "Your role can't assign work." });
      const title = String(body.title || "").trim().slice(0, 140);
      if (!title) return out(req, 400, { error: "Add a title." });
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40) as Row[];
      if (!items.length) return out(req, 400, { error: "Add at least one person." });
      const priority = PRIO.includes(body.priority) ? body.priority : "medium";
      const assignedDate = isDate(body.assigned_date) ? body.assigned_date : ymdIst();
      const override = !!body.allow_inactive;
      if (override && !canOverride) return out(req, 403, { error: "Only HR admin or leadership can assign work to inactive employees." });
      const brief = String(body.brief || "").trim().slice(0, 6000) || null;
      const shared = fileList(body.shared_files);
      const link = /^https?:\/\/\S+$/i.test(String(body.link || "").trim()) ? String(body.link).trim().slice(0, 1000) : null;
      const asProject = !!body.project || items.length > 1;

      // Validate every person BEFORE writing anything.
      const seen = new Set<string>();
      const plan: { e: Row; it: Row; files: Row[] }[] = [];
      for (const it of items) {
        const e = emps.find((x) => x.id === it.employee_id);
        if (!e || e.account_type === "system") return out(req, 400, { error: "One of the selected employees was not found." });
        if (!e.portal_email) return out(req, 400, { error: `${e.full_name} has no ERP login yet — set one up in HR first.` });
        if (!active(e) && !override) return out(req, 400, { error: `${e.full_name} is ${lc(e.employment_status)} — new work can't be assigned.` });
        if (!inScope(e)) return out(req, 403, { error: `${e.full_name} (${DIV[e.division] || e.division || "no department"}) is outside the departments you can assign to.` });
        if (!isDate(it.due)) return out(req, 400, { error: `Set a due date for ${e.full_name}.` });
        if (it.due < assignedDate) return out(req, 400, { error: `The due date for ${e.full_name} is before the assigned date.` });
        if (asProject && !String(it.deliverable || "").trim()) return out(req, 400, { error: `Add ${e.full_name}'s deliverable.` });
        const key = e.id + "|" + lc(it.deliverable);
        if (seen.has(key)) return out(req, 400, { error: `${e.full_name} is listed twice with the same deliverable.` });
        seen.add(key);
        plan.push({ e, it, files: fileList(it.files) });
      }

      // 1 — parent project
      let projectId: string | null = null;
      if (asProject) {
        const mixed = plan.some((p) => p.e.division !== "production");
        const pr = await db.from("work_projects").insert({
          title, shared_description: brief, kind: "multi_deliverable", created_by: actor, created_by_email: lc(auth.email),
          department: me.division || "other", scope: mixed ? "org" : "media",
        }).select("id").single();
        if (pr.error) throw new Error(pr.error.message);
        projectId = (pr.data as Row).id;
      }
      // 2 — one assignment per person (same row shape as BEWork / Media)
      const base = Date.now(), now = new Date().toISOString();
      const rows = plan.map((p, i) => {
        const media = p.e.division === "production";
        const instr = String(p.it.instructions || "").trim().slice(0, 6000);
        const own = asProject ? p.files : p.files.concat(shared);
        return {
          id: base + i, topic: title, type: String(p.it.type || "").trim().slice(0, 60) || (media ? "Video Editing" : "Task"),
          description: asProject ? (instr || String(p.it.deliverable || "").trim()) : ([brief, instr].filter(Boolean).join("\n\n") || null),
          assigned_to: p.e.full_name, employee_email: lc(p.e.portal_email), employee_id: p.e.id, department: p.e.division || "other",
          scope: media ? "media" : "org", assigned_date: assignedDate, date: p.it.due, status: "Pending", explanation: "None", asset_link: "",
          reference_file: refString(own), reference_link: link, assigned_by: actor, created_by: actor, priority, assign_approved: true, progress: 0,
          project_id: projectId, deliverable: asProject ? String(p.it.deliverable).trim().slice(0, 300) : null,
          history: [{ at: now, by: actor, action: "created", to: p.e.full_name, via: hrAdmin ? "hr" : tier, ...(override && !active(p.e) ? { override: "inactive" } : {}) }],
        };
      });
      const ins = await db.from("assignments").insert(rows).select("id");
      if (ins.error) { if (projectId) await db.from("work_projects").delete().eq("id", projectId); throw new Error(ins.error.message); }
      // 3 — reference registry (shared = assignment_id NULL)
      if (projectId) {
        const refRows: Row[] = shared.map((f) => ({ project_id: projectId, assignment_id: null, file_name: f.name, file_url: f.url, file_size: f.size, mime_type: f.type, uploaded_by: actor }));
        plan.forEach((p, i) => p.files.forEach((f) => refRows.push({ project_id: projectId, assignment_id: rows[i].id, file_name: f.name, file_url: f.url, file_size: f.size, mime_type: f.type, uploaded_by: actor })));
        if (refRows.length) { const r2 = await db.from("work_reference_files").insert(refRows); if (r2.error) console.warn("[work] refs:", r2.error.message); }
      }
      // 4 — Notification Center: one per person (realtime toast + bell), "View Work" opens the task
      const notes = rows.map((r) => ({
        recipient_email: r.employee_email, recipient_employee_id: r.employee_id, type: "work_assigned",
        title: "New work assigned", message: `${actorRole} assigned you “${title}”${r.deliverable ? " — " + r.deliverable : ""} · due ${fmtDue(r.date)}.`,
        entity_type: "assignment", entity_id: String(r.id), dedupe_key: "work-new:" + r.id, link: "work:" + r.id,
        metadata: { title, deliverable: r.deliverable, due: r.date, by: actor, project_id: projectId, scope: r.scope },
      }));
      await db.from("erp_notifications").upsert(notes, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, (e: unknown) => console.warn("[work] notify:", e));
      await db.from("hr_audit_log").insert({ actor_email: lc(auth.email), actor_name: actor, action: "work_assigned", entity: "assignment", entity_id: projectId || String(rows[0].id),
        reason: title, meta: { project_id: projectId, assignments: rows.map((r) => ({ id: r.id, to: r.assigned_to, department: r.department, deliverable: r.deliverable, due: r.date })), override } }).then(() => {}, () => {});
      return out(req, 200, { ok: true, project_id: projectId, assignments: rows.map((r) => ({ id: r.id, employee: r.assigned_to, department: r.department, scope: r.scope })) });
    }
    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("[work]", body.action, e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /work_projects|deliverable|project_id|schema cache/i.test(e.message)
      ? "Work projects need the database update 20261026_work_projects.sql." : "Something went wrong. Please try again.";
    return out(req, 500, { error: msg });
  }
});
