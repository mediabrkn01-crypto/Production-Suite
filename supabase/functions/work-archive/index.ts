// work-archive — Monthly Completed Work Archive for the WHOLE organisation (every department).
//
// Collects every completed deliverable of a month from the shared assignments table (Media
// pipeline + central Work Assignment: Media, Academics, Sales, HR, Accounts, Management…),
// grouped by project id, and builds a Google Drive archive through the EXISTING Apps Script web
// app (the Broken English account that already owns uploaded deliverables) — no second Google
// integration. Drive deliverables get shortcuts, ERP-storage files get copies, other links are
// listed in the index Sheet. Originals are never moved, renamed or modified.
//
// Who sees what (ERP session re-resolved from HR on every call, same tiers as Work Assignment):
//   org   Founder / Co-Founder / manager tier / Master Admin → all departments; create + share the
//         organisation-wide archive (and any department archive)
//   dept  Department Head / Operations Manager → their authorised departments; create + share
//         those department archives
//   self  every other employee → their own completed work + links of archives that hold it
//         (view only — no archive creation)
// One archive per (month, scope): 'org' or 'dept:<code>'. Re-runs only add new work; "Retry"
// only resends failed files. State: work_archives / work_archive_items / work_archive_projects.
//
// POST { action }
//   scope                                   → { mode, can_create, scopes[], configured, recipients }
//   preview  { month, scope }               → { projects, totals, archive? }   (nothing written)
//   create   { month, scope }  · process / retry / finalize { archive_id } · share { archive_id, emails[] }
//   get      { month, scope }  · list
//
// Secrets: WORK_ARCHIVE_KEY (= Apps Script property ARCHIVE_KEY), WORK_ARCHIVE_SCRIPT_URL (optional).
// Deploy with --no-verify-jwt (authorised by the ERP session token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext } from "../_shared/jarvis/auth.ts";
import { authorizedDivisions, DIV, tierOf, type Row } from "../_shared/aura/rules.ts";
import { collect, isMonth, MONTHS, summarize } from "./collect.ts";

const SCRIPT_URL = (Deno.env.get("WORK_ARCHIVE_SCRIPT_URL") ||
  "https://script.google.com/macros/s/AKfycbyFOBXoFwQgm0JupcSJ5yxSExVWPfZiieypPUJPHkamIaxEXO44V-5z3XxuQ32HbdiV/exec").trim();
const KEY = (Deno.env.get("WORK_ARCHIVE_KEY") || "").trim();
const BATCH = 12;            // files per Apps Script call
const SCRIPT_BUDGET = 95000; // ms the script may spend per call

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
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const scopeLabel = (k: string) => k === "org" ? "Whole organisation" : (DIV[k.slice(5)] || k.slice(5));

async function script(action: string, payload: Row, timeoutMs = 140000): Promise<Row> {
  if (!KEY) throw new Error("Monthly archive is not set up yet — WORK_ARCHIVE_KEY is missing.");
  let r: Response;
  try {
    r = await fetch(SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...payload, action, key: KEY }), redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new Error("Google Drive did not respond in time — try again. (" + ((e as Error).message || e) + ")"); }
  const text = await r.text();
  let j: Row | null = null; try { j = JSON.parse(text); } catch { j = null; }
  if (!j) throw new Error("Google Drive returned an unexpected response (HTTP " + r.status + "). Is the updated Apps Script deployed?");
  if (!j.success) throw new Error(j.error || "Google Drive refused the request.");
  return j;
}

async function fetchAll(db: any, table: string, cols: string, q: (x: any) => any): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

/** Every completed deliverable of the month, all departments (filtered per scope by the caller). */
async function monthItems(db: any, month: string) {
  const rows = await fetchAll(db, "assignments", "*", (q) => q.eq("status", "Completed"));
  const pids = [...new Set(rows.map((r) => r.project_id).filter(Boolean))];
  const projects: Record<string, Row> = {};
  for (let i = 0; i < pids.length; i += 200) {
    const { data } = await db.from("work_projects").select("id,title").in("id", pids.slice(i, i + 200));
    (data || []).forEach((p: Row) => { projects[p.id] = p; });
  }
  const teamIds = rows.filter((r) => r.assignment_type === "team").map((r) => r.id);
  const members: Record<string, Row[]> = {};
  for (let i = 0; i < teamIds.length; i += 200) {
    const { data } = await db.from("assignment_members").select("assignment_id,employee_email,employee_name,department,removed_at").in("assignment_id", teamIds.slice(i, i + 200)).is("removed_at", null);
    (data || []).forEach((m: Row) => { (members[String(m.assignment_id)] ||= []).push(m); });
  }
  return collect(rows, projects, month, members);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let auth;
  try { auth = await resolveAuthContext(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? "Your session has expired. Please sign in again." : e.message, code: e.code });
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();

  try {
    // ── who is asking, and what may they see (same tiers as Work Assignment / Aura) ──
    const cols = "id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email";
    const [er, dr, rr] = await Promise.all([
      (async () => { const r = await db.from("hr_employees").select(cols + ",managed_divisions"); return r.error && /managed_divisions/i.test(r.error.message) ? await db.from("hr_employees").select(cols) : r; })(),
      db.from("hr_designations").select("name,access_role,active"),
      db.from("user_roster").select("role").ilike("email", auth.email.replace(/[\\%_]/g, (c: string) => "\\" + c)).limit(1),
    ]);
    const emps = (er.data || []) as Row[];
    const me = emps.find((e) => e.id === auth.employeeId);
    if (!me) return out(req, 403, { error: "Your sign-in is not linked to an employee record." });
    const tier = tierOf(me, (dr.data || []) as Row[]);
    const rosterAdmin = lc((rr.data as Row[] | null)?.[0]?.role) === "admin";
    const ad = rosterAdmin ? "*" : authorizedDivisions(me, tier);
    const mode: "org" | "dept" | "self" = ad === "*" ? "org" : ad.length ? "dept" : "self";
    const myEmail = lc(auth.email);
    const actor = me.full_name || auth.name;
    const scopes: string[] = mode === "org" ? ["org", ...Object.keys(DIV).map((d) => "dept:" + d)] : mode === "dept" ? (ad as string[]).map((d) => "dept:" + d) : [];
    const canCreate = (k: string) => scopes.includes(k);
    /** Item visibility for a scope key ('self' = my own work). */
    const inScope = (k: string) => (it: Row) => k === "org" ? true : k.startsWith("dept:") ? (it.departments || [it.department]).includes(k.slice(5)) : (it.emails || []).includes(myEmail);
    const recipients = emps.filter((e) => ["founder", "co_founder"].includes(lc(e.system_role)) && !["exited", "inactive"].includes(lc(e.employment_status || "active")) && e.portal_email)
      .map((e) => ({ name: e.full_name, email: lc(e.portal_email), role: lc(e.system_role) === "founder" ? "Founder" : "Co-Founder" }));

    if (body.action === "scope") {
      return out(req, 200, { mode, can_create: scopes.length > 0, configured: !!KEY,
        scopes: (scopes.length ? scopes : ["self"]).map((k) => ({ key: k, label: k === "self" ? "My completed work" : scopeLabel(k) })),
        recipients: scopes.length ? recipients : [] });
    }

    const itemsOf = async (id: string) => fetchAll(db, "work_archive_items", "*", (q) => q.eq("archive_id", id).order("created_at"));
    const archiveById = async (id: string, needCreate = true) => {
      const { data } = await db.from("work_archives").select("*").eq("id", String(id || "")).maybeSingle();
      if (!data) throw Object.assign(new Error("Archive not found."), { status: 404 });
      if (needCreate && !canCreate(data.scope_key || "org")) throw Object.assign(new Error("You can't manage this archive."), { status: 403 });
      return data as Row;
    };

    if (body.action === "list") {
      const { data } = await db.from("work_archives").select("id,month,scope_key,status,folder_url,sheet_url,totals,shared_with,created_by,created_at,updated_at,completed_at").order("month", { ascending: false }).limit(60);
      let rows = (data || []) as Row[];
      if (mode !== "org") {
        if (mode === "dept") rows = rows.filter((a) => canCreate(a.scope_key || "org"));
        else {
          // employees: only archives that hold their own work
          const ids = rows.map((a) => a.id);
          const mine = ids.length ? await fetchAll(db, "work_archive_items", "archive_id,assignment_id", (q) => q.in("archive_id", ids)) : [];
          const own = new Set((await fetchAll(db, "assignments", "id", (q) => q.ilike("employee_email", myEmail))).map((r) => Number(r.id)));
          const { data: tm } = await db.from("assignment_members").select("assignment_id").ilike("employee_email", myEmail).is("removed_at", null);
          (tm || []).forEach((m: Row) => own.add(Number(m.assignment_id)));
          const keep = new Set(mine.filter((m) => own.has(Number(m.assignment_id))).map((m) => m.archive_id));
          rows = rows.filter((a) => keep.has(a.id)).map((a) => ({ ...a, shared_with: [] }));
        }
      }
      return out(req, 200, { archives: rows.map((a) => ({ ...a, scope_label: scopeLabel(a.scope_key || "org") })) });
    }

    if (body.action === "preview" || body.action === "get") {
      if (!isMonth(body.month)) return out(req, 400, { error: "Pick a month." });
      const key = mode === "self" ? "self" : String(body.scope || scopes[0]);
      if (key !== "self" && !canCreate(key)) return out(req, 403, { error: "You can't view that scope." });
      const items = (await monthItems(db, body.month)).filter(inScope(key)) as Row[];
      let archive: Row | null = null;
      if (key === "self") {
        // Archive links of MY items, from any archive of this month that holds them.
        const { data: arcs } = await db.from("work_archives").select("id,scope_key,folder_url,status").eq("month", body.month);
        const ids = (arcs || []).map((a: Row) => a.id), mine = new Set(items.map((x) => x.assignment_id));
        const have = ids.length ? (await fetchAll(db, "work_archive_items", "archive_id,assignment_id,file_key,status,drive_url", (q) => q.in("archive_id", ids))).filter((h) => mine.has(Number(h.assignment_id))) : [];
        const st: Record<string, Row> = {}; have.forEach((h) => { if (h.status === "done" || !st[h.assignment_id + "|" + h.file_key]) st[h.assignment_id + "|" + h.file_key] = h; });
        items.forEach((it) => { const h = st[it.assignment_id + "|" + it.file_key]; if (h) { it.status = h.status; it.drive_url = h.drive_url; } });
        const org = (arcs || []).find((a: Row) => (a.scope_key || "org") === "org") || (arcs || [])[0];
        archive = org && have.length ? { month: body.month, scope_key: org.scope_key, folder_url: org.folder_url, status: org.status, view_only: true } : null;
        if (body.action === "get") return out(req, 200, { archive, ...summarize(items) });
        return out(req, 200, { archive, view_only: true, scope: "self", ...summarize(items) });
      }
      const { data: a } = await db.from("work_archives").select("*").eq("month", body.month).eq("scope_key", key).maybeSingle();
      if (a) {
        const have = await itemsOf(a.id);
        const st: Record<string, Row> = {}; have.forEach((h) => { st[h.assignment_id + "|" + h.file_key] = h; });
        items.forEach((it) => { const h = st[it.assignment_id + "|" + it.file_key]; if (h) { it.status = h.status; it.drive_url = h.drive_url; it.error = h.error; } });
      }
      if (body.action === "get") return out(req, 200, a ? { archive: a, ...summarize(await itemsOf(a.id)) } : { archive: null });
      return out(req, 200, { archive: a || null, scope: key, scope_label: scopeLabel(key), ...summarize(items) });
    }

    if (body.action === "create") {
      if (!isMonth(body.month)) return out(req, 400, { error: "Pick a month." });
      const key = String(body.scope || scopes[0] || "");
      if (!canCreate(key)) return out(req, 403, { error: "Only Founders, Co-Founders, management or the Department Head can create this archive." });
      const month = body.month as string;
      const items = (await monthItems(db, month)).filter(inScope(key));
      if (!items.length) return out(req, 400, { error: "No completed work in this month for " + scopeLabel(key) + "." });
      // One archive per (month, scope) — reuse it; never a second one.
      let { data: a } = await db.from("work_archives").select("*").eq("month", month).eq("scope_key", key).maybeSingle();
      if (!a) {
        const ins = await db.from("work_archives").insert({ month, scope_key: key, status: "draft", created_by: actor, created_by_email: auth.email }).select("*").single();
        if (ins.error) {
          const again = await db.from("work_archives").select("*").eq("month", month).eq("scope_key", key).maybeSingle();
          if (!again.data) throw new Error(/scope_key/.test(ins.error.message) ? "Run the 20261109_work_archives_scope.sql migration first." : ins.error.message);
          a = again.data;
        } else a = ins.data;
      }
      const [y, m] = month.split("-");
      const monthName = m + " - " + MONTHS[Number(m) - 1] + (key === "org" ? "" : " · " + scopeLabel(key));
      const f = await script("archiveFolders", { year: y, monthName, ids: { root: a.root_folder_id, year: a.year_folder_id, month: a.month_folder_id } });
      const rows = items.map((it) => ({ archive_id: a.id, assignment_id: it.assignment_id, project_key: it.project_key, project_title: it.project_title, category: it.category, creator: it.creator,
        department: it.department, completed_on: it.completed_on, deliverable_name: it.deliverable_name, source_url: it.source_url, file_key: it.file_key, kind: it.kind, status: it.status }));
      for (let i = 0; i < rows.length; i += 500) {
        const r = await db.from("work_archive_items").upsert(rows.slice(i, i + 500), { onConflict: "archive_id,assignment_id,file_key", ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message);
      }
      // Backfill the department on items recorded before 20261109 (nothing else changes).
      const dep: Record<number, string> = {}; items.forEach((it) => { dep[it.assignment_id] = it.department; });
      const all0 = await itemsOf(a.id);
      for (const h of all0.filter((x) => !x.department && dep[x.assignment_id])) await db.from("work_archive_items").update({ department: dep[h.assignment_id] }).eq("id", h.id);
      const all = await itemsOf(a.id);
      const upd = await db.from("work_archives").update({ root_folder_id: f.root, year_folder_id: f.year, month_folder_id: f.month, folder_url: f.url, status: "running",
        totals: summarize(all).totals, updated_by: actor, updated_at: new Date().toISOString(), last_error: null }).eq("id", a.id).select("*").single();
      return out(req, 200, { archive: upd.data, ...summarize(all) });
    }

    if (body.action === "process") {
      const a = await archiveById(body.archive_id);
      if (!a.month_folder_id) return out(req, 409, { error: "Create the archive first." });
      const { data: batch } = await db.from("work_archive_items").select("*").eq("archive_id", a.id).eq("status", "pending").order("created_at").limit(BATCH);
      if (batch && batch.length) {
        const keys = [...new Set(batch.map((b: Row) => b.project_key))];
        const { data: pr } = await db.from("work_archive_projects").select("*").eq("archive_id", a.id).in("project_key", keys);
        const pmap: Record<string, Row> = {}; (pr || []).forEach((p: Row) => { pmap[p.project_key] = p; });
        const projects: Record<string, Row> = {};
        batch.forEach((b: Row) => {
          if (projects[b.project_key]) return;
          const short = b.project_key.startsWith("task-") ? "#" + b.project_key.slice(-6) : b.project_key.slice(0, 6);
          projects[b.project_key] = { folderId: pmap[b.project_key]?.folder_id || null, name: `${b.project_title} (${short})` };
        });
        const res = await script("archiveItems", { monthFolderId: a.month_folder_id, budgetMs: SCRIPT_BUDGET, projects,
          items: batch.map((b: Row) => { const m = String(b.source_url || "").match(/\/(?:folders|d)\/([\w-]{10,})|[?&]id=([\w-]{10,})/); return { id: b.id, projectKey: b.project_key, kind: b.kind, name: b.deliverable_name, url: b.source_url, driveId: m ? (m[1] || m[2]) : null }; }) });
        const pUp = Object.entries(res.projects || {}).map(([k, v]: [string, any]) => ({ archive_id: a.id, project_key: k, title: batch.find((b: Row) => b.project_key === k)?.project_title || null, folder_id: v.folderId, folder_url: v.url }));
        if (pUp.length) await db.from("work_archive_projects").upsert(pUp, { onConflict: "archive_id,project_key" });
        const now = new Date().toISOString();
        for (const r of (res.results || []) as Row[]) {
          const cur = batch.find((b: Row) => b.id === r.id);
          await db.from("work_archive_items").update(r.ok
            ? { status: "done", drive_item_id: r.driveId, drive_url: r.url, error: null, attempts: (cur?.attempts || 0) + 1, updated_at: now }
            : { status: "failed", error: r.error || "Failed", attempts: (cur?.attempts || 0) + 1, updated_at: now }).eq("id", r.id);
        }
      }
      const totals = summarize(await itemsOf(a.id)).totals;
      await db.from("work_archives").update({ totals, updated_at: new Date().toISOString() }).eq("id", a.id);
      return out(req, 200, { archive_id: a.id, totals, remaining: totals.pending });
    }

    if (body.action === "retry") {
      const a = await archiveById(body.archive_id);
      await db.from("work_archive_items").update({ status: "pending", error: null, updated_at: new Date().toISOString() }).eq("archive_id", a.id).eq("status", "failed");
      const totals = summarize(await itemsOf(a.id)).totals;
      await db.from("work_archives").update({ status: "running", totals, updated_by: actor, updated_at: new Date().toISOString() }).eq("id", a.id);
      return out(req, 200, { archive_id: a.id, totals });
    }

    if (body.action === "finalize") {
      const a = await archiveById(body.archive_id);
      const all = await itemsOf(a.id);
      const totals = summarize(all).totals;
      if (totals.pending) return out(req, 409, { error: totals.pending + " file(s) are still being archived." });
      const label: Record<string, string> = { done: "Archived", failed: "Failed", link: "Link only", missing: "MISSING — no output file", no_output: "No output (done outside the ERP)" };
      const rows = all.slice().sort((x, y) => String(x.department || "").localeCompare(String(y.department || "")) || String(x.project_title).localeCompare(String(y.project_title)) || String(x.completed_on).localeCompare(String(y.completed_on)))
        .map((it) => [DIV[it.department] || it.department || "—", it.project_title, it.category, it.creator, it.completed_on || "", it.deliverable_name,
          it.drive_url ? { text: "Open in archive", url: it.drive_url } : it.source_url ? { text: "Open original", url: it.source_url } : { text: "—" },
          it.source_url ? { text: "Original", url: it.source_url } : { text: "—" }, label[it.status] || it.status + (it.error ? " — " + it.error : "")]);
      const [y, m] = String(a.month).split("-");
      const sheet = await script("archiveIndex", { monthFolderId: a.month_folder_id, sheetId: a.sheet_id,
        title: `Work Archive Index — ${MONTHS[Number(m) - 1]} ${y}` + ((a.scope_key || "org") === "org" ? "" : " — " + scopeLabel(a.scope_key)),
        header: ["Department", "Project", "Category", "Employee", "Completed", "Deliverable", "Archive link", "Original link", "Status"], rows });
      const status = totals.failed ? "partial" : "completed";
      const upd = await db.from("work_archives").update({ sheet_id: sheet.sheetId, sheet_url: sheet.url, status, totals, completed_at: new Date().toISOString(),
        updated_by: actor, updated_at: new Date().toISOString(), last_error: totals.failed ? totals.failed + " file(s) failed" : null }).eq("id", a.id).select("*").single();
      return out(req, 200, { archive: upd.data, ...summarize(all) });
    }

    if (body.action === "share") {
      const a = await archiveById(body.archive_id);
      if (!a.month_folder_id) return out(req, 409, { error: "Create the archive first." });
      const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map(lc).filter(emailOk))].slice(0, 25) as string[];
      if (!emails.length) return out(req, 400, { error: "Choose at least one valid email." });
      const res = await script("archiveShare", { folderId: a.month_folder_id, emails });
      const prev = Array.isArray(a.shared_with) ? a.shared_with : [];
      const now = new Date().toISOString();
      const merged = prev.filter((p: Row) => !emails.includes(lc(p.email)))
        .concat((res.results || []).map((r: Row) => ({ email: lc(r.email), ok: !!r.ok, error: r.error || null, at: now, by: actor })));
      await db.from("work_archives").update({ shared_with: merged, updated_at: now }).eq("id", a.id);
      return out(req, 200, { results: res.results || [], shared_with: merged, folder_url: a.folder_url });
    }

    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    const status = (e as Row)?.status || 500;
    console.error("[work-archive]", (e as Error).message);
    if (body.archive_id && status === 500) await adminClient().from("work_archives").update({ last_error: String((e as Error).message).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", body.archive_id).then(() => {}, () => {});
    return out(req, status, { error: (e as Error).message || "Something went wrong." });
  }
});
