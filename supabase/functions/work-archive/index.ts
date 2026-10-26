// work-archive — Media Suite → Completed Work History → "Create Monthly Archive".
//
// Collects every completed Media deliverable of a month (grouped by project id), and builds
//   Broken English Work Archive / <Year> / <MM - Month> / <Project> / deliverables
// in the Broken English Google Drive through the EXISTING Apps Script web app (the account that
// already owns the uploaded deliverables) — no second Google integration. Drive deliverables get
// shortcuts, ERP-storage files get copies, other links are listed in the index Sheet. Originals
// are never moved, renamed or modified. The folder is private: shared with chosen people only.
//
// Auth: ERP session (x-erp-session) re-resolved from HR. Allowed: leadership (founder / co-founder /
// manager tier), Media Head, roster admin. State lives in work_archives / work_archive_items
// (server-only tables, 20261108_work_archives.sql) so a month is archived once, re-runs only add
// new work, and "Retry" only resends failed files.
//
// POST { action }
//   scope                       → { allowed, configured, recipients }
//   preview  { month }          → { projects, totals, archive? }   (nothing is written)
//   create   { month }          → archive row (created or reused) + items recorded
//   process  { archive_id }     → archives the next batch of pending files → progress
//   retry    { archive_id }     → failed files back to pending
//   finalize { archive_id }     → index Sheet + final status
//   share    { archive_id, emails[] }
//   get      { month } | list
//
// Secrets: WORK_ARCHIVE_KEY (same value as the Apps Script property ARCHIVE_KEY),
//          WORK_ARCHIVE_SCRIPT_URL (optional — defaults to the ERP's Apps Script URL).
// Deploy with --no-verify-jwt (authorised by the ERP session token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext } from "../_shared/jarvis/auth.ts";
import { LEADERSHIP, tierOf, type Row } from "../_shared/aura/rules.ts";
import { collect, isMonth, MONTHS, summarize } from "./collect.ts";

const SCRIPT_URL = (Deno.env.get("WORK_ARCHIVE_SCRIPT_URL") ||
  "https://script.google.com/macros/s/AKfycbyFOBXoFwQgm0JupcSJ5yxSExVWPfZiieypPUJPHkamIaxEXO44V-5z3XxuQ32HbdiV/exec").trim();
const KEY = (Deno.env.get("WORK_ARCHIVE_KEY") || "").trim();
const BATCH = 12;            // files per Apps Script call
const SCRIPT_BUDGET = 95000; // ms the script may spend per call (edge wall-clock stays well under its limit)

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

async function monthItems(db: any, month: string) {
  // Window wide enough for anything that could complete in the month (completed_at / submitted_at
  // / assigned date); the exact month test is done per row in collect().
  const rows = await fetchAll(db, "assignments", "*", (q) => q.eq("status", "Completed").or("scope.is.null,scope.neq.org"));
  const pids = [...new Set(rows.map((r) => r.project_id).filter(Boolean))];
  const projects: Record<string, Row> = {};
  for (let i = 0; i < pids.length; i += 200) {
    const { data } = await db.from("work_projects").select("id,title").in("id", pids.slice(i, i + 200));
    (data || []).forEach((p: Row) => { projects[p.id] = p; });
  }
  return collect(rows, projects, month);
}

function totalsOf(items: Row[]) { return summarize(items).totals; }

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
    // ── permission: leadership / Media Head / roster admin ──
    const [er, dr, rr] = await Promise.all([
      db.from("hr_employees").select("id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email"),
      db.from("hr_designations").select("name,access_role,active"),
      db.from("user_roster").select("role").ilike("email", auth.email.replace(/[\\%_]/g, (c: string) => "\\" + c)).limit(1),
    ]);
    const emps = (er.data || []) as Row[];
    const me = emps.find((e) => e.id === auth.employeeId);
    if (!me) return out(req, 403, { error: "Your sign-in is not linked to an employee record." });
    const allowed = tierOf(me, (dr.data || []) as Row[]) === "manager" || lc(me.system_role) === "media_head" || lc((rr.data as Row[] | null)?.[0]?.role) === "admin";
    const actor = me.full_name || auth.name;
    const recipients = emps.filter((e) => ["founder", "co_founder"].includes(lc(e.system_role)) && !["exited", "inactive"].includes(lc(e.employment_status || "active")) && e.portal_email)
      .map((e) => ({ name: e.full_name, email: lc(e.portal_email), role: lc(e.system_role) === "founder" ? "Founder" : "Co-Founder" }));

    if (body.action === "scope") return out(req, 200, { allowed, configured: !!KEY, recipients: allowed ? recipients : [] });
    if (!allowed) return out(req, 403, { error: "Only Co-Founders, management or the Media Head can create the monthly archive." });

    const archiveById = async (id: string) => {
      const { data } = await db.from("work_archives").select("*").eq("id", String(id || "")).maybeSingle();
      if (!data) throw Object.assign(new Error("Archive not found."), { status: 404 });
      return data as Row;
    };
    const itemsOf = async (id: string) => fetchAll(db, "work_archive_items", "*", (q) => q.eq("archive_id", id).order("created_at"));
    const view = async (a: Row) => { const items = await itemsOf(a.id); return { archive: a, ...summarize(items) }; };

    if (body.action === "list") {
      const { data } = await db.from("work_archives").select("id,month,status,folder_url,sheet_url,totals,shared_with,created_by,created_at,updated_at,completed_at").order("month", { ascending: false }).limit(24);
      return out(req, 200, { archives: data || [] });
    }

    if (body.action === "preview" || body.action === "get") {
      if (!isMonth(body.month)) return out(req, 400, { error: "Pick a month." });
      const { data: a } = await db.from("work_archives").select("*").eq("month", body.month).maybeSingle();
      if (body.action === "get") return out(req, 200, a ? await view(a) : { archive: null });
      const items = await monthItems(db, body.month);
      // Mark what an existing archive of this month already holds — those are not sent again.
      if (a) {
        const have = await itemsOf(a.id);
        const st: Record<string, Row> = {}; have.forEach((h) => { st[h.assignment_id + "|" + h.file_key] = h; });
        items.forEach((it: Row) => { const h = st[it.assignment_id + "|" + it.file_key]; if (h) { it.status = h.status; it.drive_url = h.drive_url; it.error = h.error; } });
      }
      return out(req, 200, { archive: a || null, ...summarize(items) });
    }

    if (body.action === "create") {
      if (!isMonth(body.month)) return out(req, 400, { error: "Pick a month." });
      const month = body.month as string;
      const items = await monthItems(db, month);
      if (!items.length) return out(req, 400, { error: "No completed work in this month." });
      // One archive per month — reuse it (unique month); never a second one.
      let { data: a } = await db.from("work_archives").select("*").eq("month", month).maybeSingle();
      if (!a) {
        const ins = await db.from("work_archives").insert({ month, status: "draft", created_by: actor, created_by_email: auth.email }).select("*").single();
        if (ins.error) {
          const again = await db.from("work_archives").select("*").eq("month", month).maybeSingle();   // created concurrently
          if (!again.data) throw new Error(ins.error.message);
          a = again.data;
        } else a = ins.data;
      }
      // Drive folders (created once, then reused by id).
      const [y, m] = month.split("-");
      const f = await script("archiveFolders", { year: y, monthName: m + " - " + MONTHS[Number(m) - 1], ids: { root: a.root_folder_id, year: a.year_folder_id, month: a.month_folder_id } });
      // Record every deliverable; ones already recorded are left as they are (no duplicates).
      const rows = items.map((it) => ({ archive_id: a.id, assignment_id: it.assignment_id, project_key: it.project_key, project_title: it.project_title, category: it.category, creator: it.creator,
        completed_on: it.completed_on, deliverable_name: it.deliverable_name, source_url: it.source_url, file_key: it.file_key, kind: it.kind, status: it.status }));
      for (let i = 0; i < rows.length; i += 500) {
        const r = await db.from("work_archive_items").upsert(rows.slice(i, i + 500), { onConflict: "archive_id,assignment_id,file_key", ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message);
      }
      const all = await itemsOf(a.id);
      const upd = await db.from("work_archives").update({ root_folder_id: f.root, year_folder_id: f.year, month_folder_id: f.month, folder_url: f.url, status: "running",
        totals: totalsOf(all), updated_by: actor, updated_at: new Date().toISOString(), last_error: null }).eq("id", a.id).select("*").single();
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
      const all = await itemsOf(a.id);
      const totals = totalsOf(all);
      await db.from("work_archives").update({ totals, updated_at: new Date().toISOString() }).eq("id", a.id);
      return out(req, 200, { archive_id: a.id, totals, remaining: totals.pending });
    }

    if (body.action === "retry") {
      const a = await archiveById(body.archive_id);
      await db.from("work_archive_items").update({ status: "pending", error: null, updated_at: new Date().toISOString() }).eq("archive_id", a.id).eq("status", "failed");
      const all = await itemsOf(a.id);
      await db.from("work_archives").update({ status: "running", totals: totalsOf(all), updated_by: actor, updated_at: new Date().toISOString() }).eq("id", a.id);
      return out(req, 200, { archive_id: a.id, totals: totalsOf(all) });
    }

    if (body.action === "finalize") {
      const a = await archiveById(body.archive_id);
      const all = await itemsOf(a.id);
      const totals = totalsOf(all);
      if (totals.pending) return out(req, 409, { error: totals.pending + " file(s) are still being archived." });
      const label: Record<string, string> = { done: "Archived", failed: "Failed", link: "Link only", missing: "MISSING — no output file", no_output: "No output (done outside the ERP)" };
      const rows = all.slice().sort((x, y) => String(x.project_title).localeCompare(String(y.project_title)) || String(x.completed_on).localeCompare(String(y.completed_on)))
        .map((it) => [it.project_title, it.category, it.creator, it.completed_on || "", it.deliverable_name,
          it.drive_url ? { text: "Open in archive", url: it.drive_url } : it.source_url ? { text: "Open original", url: it.source_url } : { text: "—" },
          it.source_url ? { text: "Original", url: it.source_url } : { text: "—" }, label[it.status] || it.status + (it.error ? " — " + it.error : "")]);
      const [y, m] = String(a.month).split("-");
      const sheet = await script("archiveIndex", { monthFolderId: a.month_folder_id, sheetId: a.sheet_id, title: `Work Archive Index — ${MONTHS[Number(m) - 1]} ${y}`,
        header: ["Project", "Category", "Creator", "Completed", "Deliverable", "Archive link", "Original link", "Status"], rows });
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
    // record the failure on the archive when we know which one
    if (body.archive_id) await adminClient().from("work_archives").update({ last_error: String((e as Error).message).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", body.archive_id).then(() => {}, () => {});
    return out(req, status, { error: (e as Error).message || "Something went wrong." });
  }
});
