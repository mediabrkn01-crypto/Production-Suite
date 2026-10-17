// POST /functions/v1/calendar — the ONLY write path for the Content Calendar (deploy with
// --no-verify-jwt; the caller is identified by their ERP session token, x-erp-session, like
// Aura / Jarvis). Every request re-reads the caller from HR, so role / department changes and
// exits apply immediately. Nothing role-related from the browser is trusted.
//
//   {action:"scope"}                                      what I may see / manage + who I may assign
//   {action:"save", item:{id?,…}, assignees:[employee ids]} create or edit (managers of that department)
//   {action:"status", id, occ_date?, status}              planned | in_progress | completed | cancelled
//   {action:"list", from, to}                             items I may see in a date range (+ assignees, occurrences)
//   {action:"item", id}                                   one item, only if I may see it
//
// Authority (same effective-access rules as Aura, _shared/aura/rules.ts):
//   manager tier (leadership system role / management account) → manage every department + company-wide
//   HR admin (system role hr_admin) → manage HR + company-wide; see every department
//   operational_manager / head     → manage own division (+ managed_divisions for Operations Managers)
//   employee                       → view; update status of items assigned to them
// Viewing (enforced HERE — the browser cannot read the calendar tables, 20261031):
//   manager tier / HR admin → every department
//   everyone else           → own division + departments they manage + company-wide
//                             + the individual items assigned to them (not that department's calendar)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { authorizedDivisions, clean, DIV, tierOf, type Row } from "../_shared/aura/rules.ts";

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
const STATUSES = ["planned", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["low", "medium", "high"];
const RECUR = ["daily", "weekly", "weekdays", "monthly"];
const REMINDER = /^(morning|start|10|30|60|m:\d{1,5})$/;
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown) => typeof s === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(s);
const url = (s: unknown) => { const v = String(s ?? "").trim(); return /^https?:\/\/\S+$/i.test(v) ? v.slice(0, 1000) : null; };

interface Ctx { auth: JarvisAuthContext; me: Row; tier: string; emps: Row[]; manage: "*" | string[]; company: boolean; viewAll: boolean; hrAdmin: boolean }

async function context(req: Request): Promise<Ctx> {
  const auth = await resolveAuthContext(req);
  const db = adminClient();
  // Never select("*") here: hr_employees carries base64 photos.
  const cols = "id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email,photo_url";
  const loadEmps = async (): Promise<Row[]> => {
    const r = await db.from("hr_employees").select(cols + ",managed_divisions");
    if (r.error && /managed_divisions/i.test(r.error.message)) { const r2 = await db.from("hr_employees").select(cols); if (r2.error) throw new Error(r2.error.message); return (r2.data || []) as Row[]; }
    if (r.error) throw new Error(r.error.message);
    return (r.data || []) as unknown as Row[];
  };
  const [emps, desR, rosR] = await Promise.all([
    loadEmps(),
    db.from("hr_designations").select("name,access_role,active"),
    db.from("user_roster").select("role").ilike("email", auth.email.replace(/[\\%_]/g, (c) => "\\" + c)).limit(1),
  ]);
  const me = emps.find((e) => e.id === auth.employeeId);
  if (!me) throw new JarvisAuthError(403, "FORBIDDEN", "Your sign-in is not linked to an employee record.");
  const tier = tierOf(me, (desR.data || []) as Row[]);
  // HR's organisation-wide calendar access comes from the HR admin system role only — not from
  // being in the HR division, payroll permission or the app-admin roster flag.
  const hrAdmin = lc(me.system_role) === "hr_admin";
  void rosR;
  let manage: "*" | string[] = authorizedDivisions(me, tier);
  if (hrAdmin && manage !== "*" && !manage.includes("hr")) manage = [...manage, "hr"];
  const company = tier === "manager" || hrAdmin;
  const viewAll = tier === "manager" || hrAdmin;
  return { auth, me, tier, emps, manage, company, viewAll, hrAdmin };
}
const active = (e: Row) => !["exited", "inactive"].includes(lc(e.employment_status || "active")) && e.account_type !== "system";
const canManageDept = (c: Ctx, dept: string) => dept === "company" ? c.company : (c.manage === "*" || c.manage.includes(dept));
// Who may be assigned to an item of this department.
const assignable = (c: Ctx, dept: string) => c.emps.filter((e) => active(e) && (dept === "company" || c.manage === "*" || e.division === dept));
// Departments whose whole calendar I may browse ("*" = all). Company-wide is always visible.
const visibleDepts = (c: Ctx): "*" | string[] => c.viewAll ? "*" : [...new Set([c.me.division, ...(c.manage === "*" ? [] : c.manage)].filter(Boolean) as string[])];
const canSee = (c: Ctx, it: Row, mine: Set<string>) => { const v = visibleDepts(c); return v === "*" || it.department === "company" || v.includes(it.department) || mine.has(it.id); };
const ymdIst = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let c: Ctx;
  try { c = await context(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[calendar] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();
  const actorName = c.me.full_name || c.auth.name;

  try {
    switch (body.action) {
      case "scope": {
        const depts = c.manage === "*" ? Object.keys(DIV) : c.manage;
        const mgr = new Set(depts);
        // People I may assign (any department I manage; everyone for company-wide items).
        const people = c.emps.filter((e) => active(e) && (c.company || c.manage === "*" || mgr.has(e.division)))
          .map((e) => ({ id: e.id, name: e.full_name, division: e.division, designation: clean(e.designation) || "", photo_url: e.photo_url || null }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const vis = visibleDepts(c);
        return out(req, 200, {
          me: { id: c.me.id, name: actorName, division: c.me.division || null },
          tier: c.tier, view_all: c.viewAll, can_company: c.company,
          view_departments: vis,
          manage_departments: c.manage === "*" ? "*" : c.manage,
          departments: Object.keys(DIV).map((k) => ({ code: k, name: DIV[k] })),
          people,
        });
      }

      case "list": {
        const from = String(body.from || ""), to = String(body.to || "");
        if (!isDate(from) || !isDate(to) || to < from) return out(req, 400, { error: "Bad date range." });
        const vis = visibleDepts(c);
        const mineR = await db.from("content_calendar_assignees").select("item_id").eq("employee_id", c.me.id);
        const mine = new Set(((mineR.data || []) as Row[]).map((r) => r.item_id));
        // Only rows I may see leave the server: my departments + company-wide (+ my own items).
        let q = db.from("content_calendar_items").select("*")
          .or(`and(recurrence.is.null,item_date.gte.${from},item_date.lte.${to}),and(recurrence.not.is.null,item_date.lte.${to})`).limit(3000);
        if (vis !== "*") q = q.in("department", [...vis, "company"]);
        const r = await q;
        if (r.error) throw new Error(r.error.message);
        let items = ((r.data || []) as Row[]).filter((i) => !i.recurrence || !i.recurrence_until || i.recurrence_until >= from);
        if (vis !== "*" && mine.size) {   // assigned items from other departments — only those exact items
          const extra = await db.from("content_calendar_items").select("*").in("id", [...mine].slice(0, 500))
            .or(`and(recurrence.is.null,item_date.gte.${from},item_date.lte.${to}),and(recurrence.not.is.null,item_date.lte.${to})`);
          const have = new Set(items.map((i) => i.id));
          ((extra.data || []) as Row[]).forEach((i) => { if (!have.has(i.id) && (!i.recurrence || !i.recurrence_until || i.recurrence_until >= from)) items.push(i); });
        }
        items = items.filter((i) => canSee(c, i, mine));
        const ids = items.map((i) => i.id);
        const asg: Row[] = [], occ: Row[] = [];
        for (let k = 0; k < ids.length; k += 200) {
          const part = ids.slice(k, k + 200);
          const a = await db.from("content_calendar_assignees").select("item_id,employee_id").in("item_id", part);
          asg.push(...((a.data || []) as Row[]));
          const rec = items.filter((i) => i.recurrence && part.includes(i.id)).map((i) => i.id);
          if (rec.length) { const o = await db.from("content_calendar_occurrences").select("*").in("item_id", rec).gte("occ_date", from).lte("occ_date", to); occ.push(...((o.data || []) as Row[])); }
        }
        const names: Record<string, string> = {};
        asg.forEach((a) => { const e = c.emps.find((x) => x.id === a.employee_id); if (e) names[e.id] = e.full_name; });
        return out(req, 200, { items, assignees: asg, occurrences: occ, names });
      }

      case "item": {
        const p = await db.from("content_calendar_items").select("*").eq("id", body.id).maybeSingle();
        if (!p.data) return out(req, 404, { error: "That item no longer exists." });
        const a = await db.from("content_calendar_assignees").select("employee_id").eq("item_id", body.id);
        const ids = ((a.data || []) as Row[]).map((x) => x.employee_id);
        const it = p.data as Row;
        if (!canSee(c, it, new Set(ids.includes(c.me.id) ? [it.id] : []))) return out(req, 403, { error: "This item is outside your calendar." });
        let occ: Row | null = null;
        if (it.recurrence && isDate(body.occ_date)) { const o = await db.from("content_calendar_occurrences").select("*").eq("item_id", it.id).eq("occ_date", body.occ_date).maybeSingle(); occ = (o.data as Row) || null; }
        const names: Record<string, string> = {};
        ids.forEach((id) => { const e = c.emps.find((x) => x.id === id); if (e) names[id] = e.full_name; });
        return out(req, 200, { item: { ...it, assignees: ids }, occurrence: occ, names });
      }

      case "save": {
        const it = (body.item || {}) as Row;
        const title = String(it.title || "").trim().slice(0, 200);
        const dept = String(it.department || "").trim();
        if (!title) return out(req, 400, { error: "Add a title." });
        if (!dept) return out(req, 400, { error: "Choose a department." });
        if (!isDate(it.item_date)) return out(req, 400, { error: "Choose a date." });
        if (dept !== "company" && !DIV[dept]) {
          const d = await db.from("hr_divisions").select("code").eq("code", dept).maybeSingle();
          if (!d.data) return out(req, 400, { error: "Unknown department." });
        }
        if (!canManageDept(c, dept)) return out(req, 403, { error: dept === "company" ? "Only Management or HR can add company-wide items." : "You can only add items for your own department(s)." });
        let prev: Row | null = null;
        if (it.id) {
          const p = await db.from("content_calendar_items").select("*").eq("id", it.id).maybeSingle();
          if (!p.data) return out(req, 404, { error: "That item no longer exists." });
          prev = p.data as Row;
          if (!canManageDept(c, prev.department)) return out(req, 403, { error: "You can't edit items of that department." });
        }
        const reminders = (Array.isArray(it.reminders) ? it.reminders : []).map(String).filter((r: string) => REMINDER.test(r)).slice(0, 6);
        const recurrence = RECUR.includes(it.recurrence) ? it.recurrence : null;
        const row: Row = {
          title, department: dept,
          description: String(it.description || "").trim().slice(0, 4000) || null,
          item_type: String(it.item_type || "other").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40) || "other",
          platform: String(it.platform || "").trim().slice(0, 40) || null,
          item_date: it.item_date, start_time: isTime(it.start_time) ? it.start_time : null,
          priority: PRIORITIES.includes(it.priority) ? it.priority : "medium",
          status: STATUSES.includes(it.status) ? it.status : (prev?.status || "planned"),
          reminders, recurrence,
          recurrence_days: recurrence === "weekdays" ? (Array.isArray(it.recurrence_days) ? it.recurrence_days : []).map(Number).filter((n: number) => n >= 0 && n <= 6) : [],
          recurrence_until: recurrence && isDate(it.recurrence_until) ? it.recurrence_until : null,
          reference_url: url(it.reference_url), attachment_url: url(it.attachment_url),
          related_assignment_id: it.related_assignment_id ? Number(it.related_assignment_id) || null : null,
          updated_at: new Date().toISOString(),
        };
        if (row.status === "completed" && prev?.status !== "completed") { row.completed_by = actorName; row.completed_at = new Date().toISOString(); }
        if (row.status !== "completed") { row.completed_by = null; row.completed_at = null; }
        // Assignees: must be people I may assign for THIS department.
        const allowed = new Set(assignable(c, dept).map((e) => e.id));
        const want: string[] = [...new Set((Array.isArray(body.assignees) ? body.assignees : []).map(String))].slice(0, 40) as string[];
        const bad = want.filter((id) => !allowed.has(id));
        if (bad.length) return out(req, 403, { error: "Some selected people are outside this department." });

        let saved: Row;
        if (prev) {
          const u = await db.from("content_calendar_items").update(row).eq("id", prev.id).select("*").single();
          if (u.error) throw new Error(u.error.message); saved = u.data as Row;
        } else {
          const ins = await db.from("content_calendar_items").insert({ ...row, created_by_employee_id: c.me.id, created_by_name: actorName }).select("*").single();
          if (ins.error) throw new Error(ins.error.message); saved = ins.data as Row;
        }
        const cur = await db.from("content_calendar_assignees").select("employee_id").eq("item_id", saved.id);
        const had = new Set(((cur.data || []) as Row[]).map((r) => r.employee_id));
        const drop = [...had].filter((id) => !want.includes(id));
        const add = want.filter((id) => !had.has(id));
        if (drop.length) await db.from("content_calendar_assignees").delete().eq("item_id", saved.id).in("employee_id", drop);
        if (add.length) { const a = await db.from("content_calendar_assignees").insert(add.map((id) => ({ item_id: saved.id, employee_id: id }))); if (a.error) throw new Error(a.error.message); }
        // Newly assigned people get one Notification Center entry each (never duplicated).
        const when = saved.item_date === ymdIst() ? "Today" : saved.item_date;
        for (const id of add) {
          const e = c.emps.find((x) => x.id === id);
          if (!e?.portal_email || id === c.me.id) continue;
          await db.from("erp_notifications").upsert({
            recipient_email: lc(e.portal_email), recipient_employee_id: id, type: "calendar_assigned",
            title: "New calendar item", message: `You were assigned “${title}” — due ${when}${saved.start_time ? ", " + String(saved.start_time).slice(0, 5) : ""}.`,
            entity_type: "content_calendar_item", entity_id: saved.id, dedupe_key: `cal-assign:${saved.id}:${id}`, link: `cal:${saved.id}:${saved.item_date}`,
            metadata: { title, date: saved.item_date, time: saved.start_time, department: dept, by: actorName },
          }, { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, () => {});
        }
        return out(req, 200, { ok: true, item: saved, assignees: want });
      }

      case "status": {
        const st = String(body.status || "");
        if (!STATUSES.includes(st)) return out(req, 400, { error: "Unknown status." });
        const p = await db.from("content_calendar_items").select("*").eq("id", body.id).maybeSingle();
        if (!p.data) return out(req, 404, { error: "That item no longer exists." });
        const item = p.data as Row;
        const manager = canManageDept(c, item.department);
        if (!manager) {
          const a = await db.from("content_calendar_assignees").select("employee_id").eq("item_id", item.id).eq("employee_id", c.me.id).maybeSingle();
          if (!a.data) return out(req, 403, { error: "Only the assigned people or the department's managers can update this item." });
          if (st === "cancelled") return out(req, 403, { error: "Only the department's managers can cancel an item." });
        }
        const now = new Date().toISOString();
        const done = st === "completed";
        if (item.recurrence) {
          if (!isDate(body.occ_date)) return out(req, 400, { error: "Missing date of this occurrence." });
          if (st === "cancelled" && body.all) {   // cancel the whole series
            const u = await db.from("content_calendar_items").update({ status: "cancelled", updated_at: now }).eq("id", item.id);
            if (u.error) throw new Error(u.error.message);
          } else {
            const u = await db.from("content_calendar_occurrences").upsert({ item_id: item.id, occ_date: body.occ_date, status: st, completed_by: done ? actorName : null, completed_at: done ? now : null, updated_at: now }, { onConflict: "item_id,occ_date" });
            if (u.error) throw new Error(u.error.message);
          }
        } else {
          const u = await db.from("content_calendar_items").update({ status: st, completed_by: done ? actorName : null, completed_at: done ? now : null, updated_at: now }).eq("id", item.id);
          if (u.error) throw new Error(u.error.message);
        }
        // Done / cancelled → its pending reminders are resolved (no further reminders are sent:
        // the dispatcher skips completed / cancelled occurrences).
        if (done || st === "cancelled") {
          const key = item.recurrence && !body.all ? `cal:${item.id}:${body.occ_date}` : `cal:${item.id}:`;
          await db.from("erp_notifications").update({ resolved_at: now }).like("dedupe_key", key + "%").is("resolved_at", null).then(() => {}, () => {});
        }
        return out(req, 200, { ok: true });
      }
    }
    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("[calendar]", body.action, e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /content_calendar|relation|schema cache/i.test(e.message)
      ? "The Content Calendar needs the database update 20261030_content_calendar.sql." : "Something went wrong. Please try again.";
    return out(req, 500, { error: msg });
  }
});
