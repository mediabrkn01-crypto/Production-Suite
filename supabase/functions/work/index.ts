// POST /functions/v1/work — server-checked CREATE path for the shared Work Assignment engine
// (work-tasks.js / BEWork). Deploy with --no-verify-jwt; the caller is identified by their ERP
// session token (x-erp-session), like Aura / Calendar / Share. Writes the SAME records every
// suite uses — work_projects (parent) + one `assignments` row per person (+ work_reference_files)
// — so the work shows up exactly where it always does: Media Suite pipeline for Media / Production
// people (scope 'media'), "My Assigned Tasks" for everyone else (scope 'org').
//
//   {action:"scope"}                     what I may assign: org-wide or which departments
//   {action:"list"}                      the assignments this caller owns / reviews (leadership: all)
//   {action:"review", id, decision:"approve"|"rework"|"reject", reason?}
//                                        assigner-owned review of a submitted deliverable
//   {action:"create", title, brief?, priority, assigned_date?, project?, shared_files?:[{name,url}],
//    items:[{employee_id, deliverable?, type?, instructions?, due, files?:[{name,url}]}],
//    allow_inactive?}
//       project=true (or 2+ items) → one work_projects parent + one assignment each (deliverable per
//       person). project=false with one item → a plain individual assignment. team=true (2+ items,
//       lead_id?) → ONE shared team task + assignment_members.
//
// OWNERSHIP + REVIEW (20261111_work_review_owner.sql): everything created here records
// created_by_id + reviewer_id = the caller and review_route 'assigner' — the person who assigned
// the work reviews it (approve / rework / reject), never the head of the employee's department.
// Leadership (founder / co-founder / director / management) sees and may review everything; the
// action is recorded under whoever performed it. A DB guard makes those columns server-only.
// Media Suite work (review_route NULL) keeps the Media Work Approvals workflow untouched.
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
// Before 20261111_work_review_owner.sql runs, the ownership columns don't exist yet: insert
// without them (old behaviour) instead of failing the assignment.
const OWNER_COLS = ["created_by_id", "reviewer_id", "review_route"];
async function insertAssignments(db: any, rows: Row | Row[]) {
  const r = await db.from("assignments").insert(rows).select("id");
  if (!r.error || !/created_by_id|reviewer_id|review_route|schema cache/i.test(r.error.message || "")) return r;
  const strip = (x: Row) => Object.fromEntries(Object.entries(x).filter(([k]) => !OWNER_COLS.includes(k)));
  return await db.from("assignments").insert(Array.isArray(rows) ? rows.map(strip) : strip(rows)).select("id");
}
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

    const leader = tier === "manager";
    // HR's assignments belong to HR as a whole: an HR admin sees work any HR admin created.
    const hrAdminIds = async () => {
      const ad = await db.from("user_roster").select("email").eq("role", "admin");
      const mails = new Set(((ad.data || []) as Row[]).map((r) => lc(r.email)));
      return emps.filter((e) => lc(e.system_role) === "hr_admin" || mails.has(lc(e.portal_email))).map((e) => String(e.id));
    };
    const canReview = (t: Row) => t.review_route === "assigner" && (leader || t.reviewer_id === me.id || t.created_by_id === me.id);

    // Work this caller owns: created by them (by ID) or assigned to them for review; HR admins
    // share HR's work; leadership sees every department. Never "everything in my department".
    if (body.action === "list") {
      let q = db.from("assignments").select("*").order("id", { ascending: false }).limit(3000);
      if (!leader) {
        const owners = hrAdmin ? await hrAdminIds() : [String(me.id)];
        q = q.or(`created_by_id.in.(${owners.join(",")}),reviewer_id.eq.${me.id}`);
      }
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      const rows = (r.data || []) as Row[];
      const teamIds = rows.filter((t) => t.assignment_type === "team").map((t) => t.id);
      const mem = teamIds.length ? ((await db.from("assignment_members").select("*").in("assignment_id", teamIds)).data || []) : [];
      return out(req, 200, { rows: rows.map((t) => ({ ...t, can_review: canReview(t) })), members: mem, me: { id: me.id, leader, hr: hrAdmin } });
    }

    // Assigner-owned review. One decision per submission: the update only matches a row that is
    // still waiting (Completed + not approved; Rejected for a rework reopen), so a second reviewer
    // (e.g. a Co-Founder and the assigner at once) gets 409 instead of a duplicate approval.
    if (body.action === "review") {
      const id = Number(body.id), decision = String(body.decision || ""), reason = String(body.reason || "").trim().slice(0, 2000);
      if (!id || !["approve", "rework", "reject"].includes(decision)) return out(req, 400, { error: "Bad request." });
      const { data: t } = await db.from("assignments").select("*").eq("id", id).maybeSingle();
      if (!t) return out(req, 404, { error: "This work no longer exists." });
      if (t.review_route !== "assigner") return out(req, 409, { error: "This work follows the Media Work Approvals workflow." });
      if (!canReview(t)) return out(req, 403, { error: "Only the person who assigned this work (or leadership) can review it." });
      if (decision !== "approve" && !reason) return out(req, 400, { error: decision === "rework" ? "Explain what needs to change." : "Add the reason for rejecting." });
      const waiting = t.status === "Completed" && !t.manager_approved;
      if (!(waiting || (decision === "rework" && t.status === "Rejected"))) {
        const by = t.manager_approved ? (t.approved_by || "someone") : (t.reviewed_by || t.rejected_by || "");
        return out(req, 409, { error: t.manager_approved ? `Already approved by ${by}.` : t.status === "Completed" ? "Already reviewed." : `Nothing to review — this work is ${t.status}${by ? " (" + by + ")" : ""}.` });
      }
      const now = new Date().toISOString(), hist = Array.isArray(t.history) ? t.history : [];
      const role = t.reviewer_id === me.id || t.created_by_id === me.id ? "assigner" : "leadership";
      const version = hist.filter((h: Row) => h && h.output && String(h.output.asset_link || "").trim()).length + 1;
      const output = { asset_link: t.asset_link || "", submitted_at: t.submitted_at || t.completed_at || null, note: t.explanation && t.explanation !== "None" ? t.explanation : null };
      const entry: Row = { at: now, by: actor, by_id: me.id, role, action: decision === "approve" ? "approved" : decision === "rework" ? "rework" : "rejected", ...(reason ? { note: reason } : {}),
        ...(decision === "approve" ? {} : { version, output }) };
      const patch: Row = decision === "approve"
        ? { manager_approved: true, approved_by: actor, approved_by_id: me.id, approved_at: now, reviewed_by: actor, reviewed_by_id: me.id, reviewed_at: now }
        : decision === "rework"
          ? { status: "Rework Required", rework_reason: reason, reviewed_by: actor, reviewed_by_id: me.id, reviewed_at: now, completed_at: null, manager_approved: false }
          : { status: "Rejected", rejection_reason: reason, rejected_by: actor, rejected_by_id: me.id, rejected_at: now, reviewed_by: actor, reviewed_by_id: me.id, reviewed_at: now, manager_approved: false };
      let uq = db.from("assignments").update({ ...patch, history: [...hist, entry] }).eq("id", id).eq("status", t.status);
      if (t.status === "Completed") uq = t.manager_approved == null ? uq.is("manager_approved", null) : uq.eq("manager_approved", false);
      const up = await uq.select("*");
      if (up.error) throw new Error(up.error.message);
      if (!up.data || !up.data.length) return out(req, 409, { error: "Someone just reviewed this work — refresh to see the decision." });
      const row = (up.data as Row[])[0];
      // Notify the people who did the work (every active team member), and the assigner when
      // leadership decided for them. One notification per decision (dedupe on history length).
      const people: Row[] = t.assignment_type === "team"
        ? (((await db.from("assignment_members").select("employee_id,employee_email").eq("assignment_id", id).is("removed_at", null)).data || []) as Row[])
        : [{ employee_id: t.employee_id, employee_email: t.employee_email }];
      const verb = decision === "approve" ? "approved" : decision === "rework" ? "sent back for rework" : "rejected";
      const msg = `${actor} ${verb} “${t.topic || "your work"}”${t.deliverable ? " — " + t.deliverable : ""}${reason ? ": " + reason : "."}`;
      const k = "work-review:" + id + ":" + (hist.length + 1);
      const notes: Row[] = people.filter((p) => p.employee_email).map((p) => ({ recipient_email: lc(p.employee_email), recipient_employee_id: p.employee_id || null,
        type: decision === "approve" ? "work_approved" : decision === "rework" ? "work_rework" : "work_rejected",
        title: decision === "approve" ? "Work approved" : decision === "rework" ? "Rework requested" : "Work rejected",
        message: msg, entity_type: "assignment", entity_id: String(id), dedupe_key: k, link: "work:" + id, metadata: { by: actor, by_id: me.id, decision, reason: reason || null } }));
      if (role === "leadership" && t.reviewer_id) {
        const asg = emps.find((e) => e.id === t.reviewer_id);
        if (asg?.portal_email) notes.push({ recipient_email: lc(asg.portal_email), recipient_employee_id: asg.id, type: "work_reviewed", title: "Work reviewed by leadership",
          message: msg, entity_type: "assignment", entity_id: String(id), dedupe_key: k, link: "work:" + id, metadata: { by: actor, by_id: me.id, decision } });
      }
      if (notes.length) await db.from("erp_notifications").upsert(notes, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, (e: unknown) => console.warn("[work] notify:", e));
      await db.from("hr_audit_log").insert({ actor_email: lc(auth.email), actor_name: actor, action: "work_" + entry.action, entity: "assignment", entity_id: String(id),
        reason: reason || null, meta: { role, reviewer_id: t.reviewer_id, created_by_id: t.created_by_id } }).then(() => {}, () => {});
      return out(req, 200, { ok: true, row: { ...row, can_review: canReview(row) } });
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
      const team = !!body.team;
      if (team && items.length < 2) return out(req, 400, { error: "Choose at least 2 team members." });
      const asProject = !team && (!!body.project || items.length > 1);

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
        if (team && plan.some((p) => p.e.id === e.id)) return out(req, 400, { error: `${e.full_name} is listed twice.` });
        const key = e.id + "|" + lc(it.deliverable);
        if (seen.has(key)) return out(req, 400, { error: `${e.full_name} is listed twice with the same deliverable.` });
        seen.add(key);
        plan.push({ e, it, files: fileList(it.files) });
      }

      // Team work: ONE shared task (scope org — stays out of the Media pipeline) + one member row each.
      if (team) {
        const lead = plan.find((p) => p.e.id === body.lead_id)?.e || plan[0].e;
        const id = Date.now(), now = new Date().toISOString(), due = plan[0].it.due;
        const row = {
          id, topic: title, type: String(plan[0].it.type || "").trim().slice(0, 60) || "Task", description: brief,
          assigned_to: lead.full_name, employee_email: lc(lead.portal_email), employee_id: lead.id, department: lead.division || "other",
          scope: "org", assigned_date: assignedDate, date: due, status: "Pending", explanation: "None", asset_link: "",
          reference_file: refString(shared), reference_link: link, assigned_by: actor, created_by: actor, priority, assign_approved: true, progress: 0,
          assignment_type: "team", team_lead_id: body.lead_id ? lead.id : null,
          created_by_id: me.id, reviewer_id: me.id, review_route: "assigner", manager_approved: false,
          history: [{ at: now, by: actor, by_id: me.id, action: "created", to: plan.map((p) => p.e.full_name).join(", "), team: true, via: hrAdmin ? "hr" : tier }],
        };
        const ins = await insertAssignments(db, row);
        if (ins.error) throw new Error(ins.error.message);
        const mr = await db.from("assignment_members").insert(plan.map((p) => ({ assignment_id: id, employee_id: p.e.id, employee_email: lc(p.e.portal_email), employee_name: p.e.full_name,
          department: p.e.division || "other", member_role: body.lead_id && p.e.id === lead.id ? "lead" : "member", added_by: actor })));
        if (mr.error) { await db.from("assignments").delete().eq("id", id); throw new Error(mr.error.message); }
        await db.from("erp_notifications").upsert(plan.map((p) => ({
          recipient_email: lc(p.e.portal_email), recipient_employee_id: p.e.id, type: "work_assigned", title: "New work assigned",
          message: `${actorRole} assigned you “${title}” (team work) · due ${fmtDue(due)}.`, entity_type: "assignment", entity_id: String(id),
          dedupe_key: "work-new:" + id + ":" + lc(p.e.portal_email), link: "work:" + id, metadata: { title, due, by: actor, team: true },
        })), { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, (e: unknown) => console.warn("[work] notify:", e));
        return out(req, 200, { ok: true, team: true, assignments: [{ id, employee: lead.full_name, department: row.department, scope: "org" }] });
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
          created_by_id: me.id, reviewer_id: me.id, review_route: "assigner", manager_approved: false,
          project_id: projectId, deliverable: asProject ? String(p.it.deliverable).trim().slice(0, 300) : null,
          history: [{ at: now, by: actor, by_id: me.id, action: "created", to: p.e.full_name, via: hrAdmin ? "hr" : tier, ...(override && !active(p.e) ? { override: "inactive" } : {}) }],
        };
      });
      const ins = await insertAssignments(db, rows);
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
