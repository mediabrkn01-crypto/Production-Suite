// POST /functions/v1/share — internal file sharing ("Send"). Deploy with --no-verify-jwt; the
// caller is identified by their ERP session token (x-erp-session), like Calendar / Aura. The
// share tables have no browser access (20261103_file_shares.sql) — this is the only way in.
//
//   {action:"targets"}                                   who I may send to (people + groups)
//   {action:"send", source:{type:"assignment",id} | {type:"forward",rid},
//      files:[index…], targets:[key…], message?, forward_allowed?}
//   {action:"inbox"}                                      what was sent to me (+ unread count)
//   {action:"open", rid}                                  one received item WITH file links; marks Viewed
//   {action:"file", rid, index}                           a file's download link; marks Downloaded
//   {action:"sent"}                                       what I sent + every recipient's status
//
// Nothing is uploaded or copied: a share stores pointers ({name,url}) to the approved work's
// existing delivery files, re-read from the assignment on the server at send time.
//
// Who may send approved work: its creator, Media Head, any department head / Operations
// Manager, HR admin, Management (same effective-access tiers as Aura, _shared/aura/rules.ts).
// Recipients a sender may pick:
//   Management / HR admin        → anyone; every department (all or head only); role groups
//   Heads / Operations Managers  → people of the departments they manage + every head;
//                                  "all" of departments they manage; "head only" of any department
//   Creator (employee)           → people of own department + every head; "head only" of any department
// Groups are expanded to the CURRENT active employees at send time (never names).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, JarvisAuthError, resolveAuthContext, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { authorizedDivisions, clean, DIV, managedDivisions, tierOf, type Row } from "../_shared/aura/rules.ts";

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
const MAX_RECIPIENTS = 300;

// ── delivery entries (same format + rules as app.html beParseDelivery) ──────────────
// asset_link = "name|url" entries joined by ";;" (legacy ","); "__folder__|url" = a Drive folder.
interface Entry { name: string; url: string; folder: boolean }
function parseDelivery(s: unknown): Entry[] {
  const str = String(s ?? ""); if (!str.trim()) return [];
  const raw = str.indexOf(";;") > -1 ? str.split(";;") : str.split(",");
  return raw.map((p) => {
    p = (p || "").trim(); if (!p) return null;
    let name = "", url = p;
    const i = p.indexOf("|"); if (i > -1) { name = p.slice(0, i).trim(); url = p.slice(i + 1).trim(); }
    if (!/^https?:\/\//i.test(url)) return null;
    const folder = name === "__folder__" || /\/folders\//i.test(url);
    return { name: name === "__folder__" ? "" : name, url, folder };
  }).filter(Boolean) as Entry[];
}
function fileName(e: Entry): string {
  if (e.name) return e.name.slice(0, 200);
  if (e.folder) return "Delivery folder";
  try { const n = decodeURIComponent(new URL(e.url).pathname.split("/").pop() || ""); if (n && /\.[a-z0-9]{2,5}$/i.test(n)) return n.slice(0, 200); } catch { /* */ }
  if (/drive\.google\.com|docs\.google\.com/i.test(e.url)) return "Google Drive file";
  if (/youtube\.com|youtu\.be/i.test(e.url)) return "YouTube video";
  return "Delivery link";
}
const driveId = (u: string) => (u.match(/\/file\/d\/([^/]+)/) || u.match(/[?&]id=([^&]+)/) || [])[1] || "";
/** Direct download link where one really exists (never faked for folders / YouTube / Docs). */
function downloadHref(e: Entry): string | null {
  if (e.folder) return null;
  const low = e.url.toLowerCase();
  if (/drive\.google\.com/.test(low)) { const id = driveId(e.url); return id ? `https://drive.google.com/uc?export=download&id=${id}` : null; }
  if (/docs\.google\.com|youtube\.com|youtu\.be|vimeo\.com/.test(low)) return null;
  if (/^https?:\/\/[^?#]+\.[a-z0-9]{2,5}(\?|#|$)/i.test(e.url)) return e.url;
  return null;
}
/** In-browser preview link (Drive preview where possible, else the original). */
function viewHref(e: Entry): string {
  if (!e.folder && /drive\.google\.com/i.test(e.url)) { const id = driveId(e.url); if (id) return `https://drive.google.com/file/d/${id}/view`; }
  return e.url;
}
const kindOf = (e: Entry) => {
  if (e.folder) return "folder";
  const n = (fileName(e) + " " + e.url).toLowerCase();
  if (/\.(mp4|mov|m4v|webm|mkv|avi)\b|youtube|youtu\.be|vimeo/.test(n)) return "video";
  if (/\.(png|jpe?g|gif|webp|svg|heic)\b/.test(n)) return "image";
  if (/\.(pdf)\b/.test(n)) return "pdf";
  if (/\.(psd|ai|aep|prproj|fig|xd|indd)\b/.test(n)) return "source";
  if (/\.(mp3|wav|m4a|aac)\b/.test(n)) return "audio";
  return "file";
};

// ── caller context ───────────────────────────────────────────────────────────────
interface Ctx { auth: JarvisAuthContext; me: Row; tier: string; desig: Row[]; emps: Row[]; full: boolean; manage: string[] }
const active = (e: Row) => !["exited", "inactive"].includes(lc(e.employment_status || "active")) && e.account_type !== "system" && !!e.portal_email;

async function context(req: Request): Promise<Ctx> {
  const auth = await resolveAuthContext(req);
  const db = adminClient();
  const cols = "id,full_name,division,department,designation,system_role,account_type,employment_status,portal_email,photo_url";
  const loadEmps = async (): Promise<Row[]> => {
    const r = await db.from("hr_employees").select(cols + ",managed_divisions");
    if (r.error && /managed_divisions/i.test(r.error.message)) { const r2 = await db.from("hr_employees").select(cols); if (r2.error) throw new Error(r2.error.message); return (r2.data || []) as Row[]; }
    if (r.error) throw new Error(r.error.message);
    return (r.data || []) as unknown as Row[];
  };
  const [emps, desR, rosR] = await Promise.all([loadEmps(), db.from("hr_designations").select("name,access_role,active"), db.from("user_roster").select("email,role")]);
  // HR admin = system role hr_admin OR roster role 'admin' (same rule as the ERP / Jarvis auth).
  const rosterAdmin = new Set(((rosR.data || []) as Row[]).filter((r) => lc(r.role) === "admin").map((r) => lc(r.email)));
  emps.forEach((e) => { e._hr = lc(e.system_role) === "hr_admin" || (rosterAdmin.has(lc(e.portal_email)) && e.account_type !== "system"); });
  const me = emps.find((e) => e.id === auth.employeeId);
  if (!me) throw new JarvisAuthError(403, "FORBIDDEN", "Your sign-in is not linked to an employee record.");
  const desig = (desR.data || []) as Row[];
  const tier = tierOf(me, desig);
  const hrAdmin = !!me._hr || auth.role === "hr_admin";
  const full = tier === "manager" || hrAdmin;
  const ad = authorizedDivisions(me, tier);
  const manage = ad === "*" ? Object.keys(DIV) : [...new Set([me.division, ...ad].filter(Boolean) as string[])];
  return { auth, me, tier, desig, emps, full, manage };
}

// ── recipient targets ────────────────────────────────────────────────────────────
interface Target { key: string; kind: "person" | "dept" | "role"; label: string; sub: string; ids: string[]; division?: string | null }
function deptName(code: string) { return DIV[code] || code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
const TITLE_HEAD = /\b(head|manager|lead|director|supervisor)\b/i;
function isLead(c: Ctx, e: Row) { const t = tierOf(e, c.desig); return t === "manager" || t === "head" || t === "operational_manager" || !!e._hr; }
/** Current effective head(s) of a department — from access roles, never names. */
function headsOf(c: Ctx, code: string): Row[] {
  const live = c.emps.filter(active);
  if (code === "management") return live.filter((e) => tierOf(e, c.desig) === "manager");
  const direct = live.filter((e) => { const t = tierOf(e, c.desig); return (t === "head" || t === "operational_manager") && e.division === code; });
  if (code === "hr") { const hr = live.filter((e) => e._hr && (e.division === "hr" || !e.division || e.division === "other")); hr.forEach((e) => { if (!direct.includes(e)) direct.push(e); }); }
  if (direct.length) return direct;
  // No head inside the department → the Operations Manager(s) assigned to it …
  const ops = live.filter((e) => tierOf(e, c.desig) === "operational_manager" && managedDivisions(e).includes(code));
  if (ops.length) return ops;
  // … else whoever carries a head / manager / lead title in it.
  return live.filter((e) => e.division === code && TITLE_HEAD.test(`${clean(e.designation)} ${e.department || ""}`));
}
function roleLabel(c: Ctx, e: Row): string {
  const t = tierOf(e, c.desig);
  if (t === "manager") return "Management";
  if (e._hr) return "HR Head";
  if (t === "operational_manager") return "Operations Manager";
  if (t === "head") return deptName(e.division || "") + " Head";
  return "";
}
function targets(c: Ctx): Target[] {
  const live = c.emps.filter((e) => active(e) && e.id !== c.me.id);
  const codes = [...new Set([...Object.keys(DIV), ...live.map((e) => e.division).filter(Boolean)])] as string[];
  const res: Target[] = [];
  const canSeePerson = (e: Row) => c.full || (e.division && c.manage.includes(e.division)) || isLead(c, e);
  live.filter(canSeePerson).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).forEach((e) => {
    const role = roleLabel(c, e);
    res.push({ key: "p:" + e.id, kind: "person", label: e.full_name || e.portal_email, sub: [clean(e.designation) || role, deptName(e.division || "")].filter(Boolean).join(" · "), ids: [e.id], division: e.division || null });
  });
  for (const code of codes) {
    const members = live.filter((e) => e.division === code).map((e) => e.id);
    const heads = headsOf(c, code).filter((e) => e.id !== c.me.id).map((e) => e.id);
    const nm = code === "hr" ? "HR" : deptName(code), ppl = (n: number) => n + " active " + (n === 1 ? "person" : "people");
    if (heads.length) res.push({ key: `d:${code}:head`, kind: "dept", label: code === "management" ? "Management" : nm + " Head" + (heads.length > 1 ? "s" : ""), sub: heads.map((id) => c.emps.find((e) => e.id === id)?.full_name).filter(Boolean).join(", "), ids: heads, division: code });
    const all = members.length && (c.full || c.manage.includes(code));
    if (all) res.push({ key: `d:${code}:all`, kind: "dept", label: "All " + deptName(code), sub: ppl(members.length), ids: members, division: code });
    // A department with no head set is still reachable as a team (its current active members).
    else if (!heads.length && members.length && code !== "other" && code !== "management") res.push({ key: `d:${code}:team`, kind: "dept", label: nm + " team", sub: "No head set · " + ppl(members.length), ids: members, division: code });
  }
  const leads = live.filter((e) => { const t = tierOf(e, c.desig); return t === "head" || t === "operational_manager" || (!!e._hr && t !== "manager"); }).map((e) => e.id);
  const ops = live.filter((e) => tierOf(e, c.desig) === "operational_manager").map((e) => e.id);
  const mgmt = live.filter((e) => tierOf(e, c.desig) === "manager").map((e) => e.id);
  if (leads.length) res.push({ key: "r:heads", kind: "role", label: "All Department Heads", sub: leads.length + " people", ids: leads });
  if (ops.length) res.push({ key: "r:ops", kind: "role", label: "Operations Managers", sub: ops.length + (ops.length === 1 ? " person" : " people"), ids: ops });
  if (mgmt.length) res.push({ key: "r:mgmt", kind: "role", label: "Management", sub: mgmt.length + (mgmt.length === 1 ? " person" : " people"), ids: mgmt });
  return res;
}

async function canShareAssignment(c: Ctx, a: Row): Promise<boolean> {
  if (c.full || c.tier !== "employee") return true;                    // heads / Ops Managers / HR admin / Management
  if (lc(c.me.system_role) === "media_head" || c.auth.role === "media_head") return true;
  return lc(a.employee_email) === lc(c.auth.email);                    // the work's creator
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let c: Ctx;
  try { c = await context(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[share] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();
  const myName = c.me.full_name || c.auth.name;
  const empById = (id: string) => c.emps.find((e) => e.id === id);

  // One received item of mine (recipient row + its share), or null.
  async function mine(rid: unknown): Promise<{ r: Row; s: Row } | null> {
    if (typeof rid !== "string" || !/^[0-9a-f-]{36}$/i.test(rid)) return null;
    const r = await db.from("erp_file_share_recipients").select("*").eq("id", rid).eq("recipient_employee_id", c.me.id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data) return null;
    const s = await db.from("erp_file_shares").select("*").eq("id", (r.data as Row).share_id).maybeSingle();
    return s.data ? { r: r.data as Row, s: s.data as Row } : null;
  }
  const publicFiles = (files: Row[]) => (files || []).map((f, i) => ({ index: i, name: f.name, kind: f.kind || "file", group: f.group || null }));

  try {
    switch (body.action) {
      case "targets": {
        const t = targets(c);
        return out(req, 200, { me: { id: c.me.id, name: myName, division: c.me.division || null }, full: c.full, targets: t });
      }

      case "send": {
        const src = (body.source || {}) as Row;
        let files: Row[] = [], title = "", itemType: string | null = null, approvedAt: string | null = null, sourceType = "", sourceId = "";
        if (src.type === "assignment") {
          const a = await db.from("assignments").select("id,topic,type,employee_email,manager_approved,approved_at,asset_link,scope").eq("id", Number(src.id) || -1).maybeSingle();
          if (!a.data) return out(req, 404, { error: "That approved work no longer exists." });
          const w = a.data as Row;
          if (!w.manager_approved) return out(req, 400, { error: "Only approved work can be sent." });
          if (!(await canShareAssignment(c, w))) return out(req, 403, { error: "You don't have permission to send this work." });
          files = parseDelivery(w.asset_link).map((e) => ({ name: fileName(e), url: e.url, folder: e.folder, kind: kindOf(e) }));
          title = String(w.topic || "Approved work"); itemType = w.type || null; approvedAt = w.approved_at || null;
          sourceType = "assignment"; sourceId = String(w.id);
        } else if (src.type === "project") {
          // One multi-person project (work_projects). Its APPROVED deliverables, in assignment
          // order, each file tagged with the deliverable + person it came from.
          const pid = String(src.id || "");
          if (!/^[0-9a-f-]{36}$/i.test(pid)) return out(req, 400, { error: "Unknown project." });
          const [pr, kr] = await Promise.all([
            db.from("work_projects").select("id,title").eq("id", pid).maybeSingle(),
            db.from("assignments").select("id,topic,type,deliverable,employee_email,assigned_to,manager_approved,approved_at,asset_link,status").eq("project_id", pid),
          ]);
          const kids = ((kr.data || []) as Row[]).filter((k) => lc(k.status) !== "cancelled").sort((x, y) => Number(x.id) - Number(y.id));
          const ok = kids.filter((k) => k.manager_approved);
          if (!ok.length) return out(req, 400, { error: "No deliverable of this project is approved yet." });
          let allowed = c.full || c.tier !== "employee" || lc(c.me.system_role) === "media_head" || c.auth.role === "media_head";
          if (!allowed) allowed = ok.some((k) => lc(k.employee_email) === lc(c.auth.email));
          if (!allowed) return out(req, 403, { error: "You don't have permission to send this project." });
          const who = (k: Row) => c.emps.find((e) => lc(e.portal_email) === lc(k.employee_email))?.full_name || k.assigned_to || k.employee_email || "";
          ok.forEach((k) => parseDelivery(k.asset_link).forEach((e) => files.push({ name: fileName(e), url: e.url, folder: e.folder, kind: kindOf(e), group: `${k.type || "Deliverable"} · ${who(k)}`, assignment_id: k.id })));
          title = String((pr.data as Row | null)?.title || ok[0].topic || "Project"); itemType = "Project";
          approvedAt = ok.map((k) => k.approved_at).filter(Boolean).sort().pop() || null;
          sourceType = "project"; sourceId = pid;
        } else if (src.type === "forward") {
          const m = await mine(src.rid);
          if (!m) return out(req, 404, { error: "That shared item is no longer available." });
          if (!m.r.forward_allowed) return out(req, 403, { error: "The sender didn't allow this file to be forwarded." });
          files = (m.s.files || []) as Row[]; title = m.s.title; itemType = m.s.item_type; approvedAt = m.s.approved_at;
          sourceType = "forward"; sourceId = String(m.s.id);
        } else return out(req, 400, { error: "Unknown source." });
        if (!files.length) return out(req, 400, { error: "This work has no delivery files to send." });

        const pick = [...new Set((Array.isArray(body.files) ? body.files : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < files.length);
        if (!pick.length) return out(req, 400, { error: "Select at least one file." });
        const chosen = pick.sort((x, y) => x - y).map((i) => files[i]);

        // Expand the picked targets → people, only from what this sender may choose.
        const allowed = new Map(targets(c).map((t) => [t.key, t]));
        const keys = [...new Set((Array.isArray(body.targets) ? body.targets : []).map(String))].slice(0, 200);
        if (!keys.length) return out(req, 400, { error: "Choose at least one recipient." });
        const bad = keys.filter((k) => !allowed.has(k));
        if (bad.length) return out(req, 403, { error: "Some recipients are outside what you can send to." });
        const via = new Map<string, string>();
        keys.forEach((k) => { const t = allowed.get(k)!; t.ids.forEach((id) => { if (!via.has(id) || t.kind === "person") via.set(id, t.kind === "person" ? "person" : k); }); });
        via.delete(c.me.id);
        const ids = [...via.keys()].filter((id) => { const e = empById(id); return e && active(e); });
        if (!ids.length) return out(req, 400, { error: "No active people in that selection." });
        if (ids.length > MAX_RECIPIENTS) return out(req, 400, { error: `That's ${ids.length} people — send to at most ${MAX_RECIPIENTS} at once.` });

        const message = String(body.message || "").trim().slice(0, 600) || null;
        const row = { source_type: sourceType, source_id: sourceId, title, item_type: itemType, approved_at: approvedAt, files: chosen,
          sender_employee_id: c.me.id, sender_name: myName, sender_division: c.me.division || null, message };
        let ins = await db.from("erp_file_shares").insert(row).select("id").single();
        // 20261104 not run yet → 'project' isn't an allowed source_type; record it as an assignment-type share.
        if (ins.error && sourceType === "project" && /source_type|check constraint/i.test(ins.error.message)) ins = await db.from("erp_file_shares").insert({ ...row, source_type: "assignment", source_id: "project:" + sourceId }).select("id").single();
        if (ins.error) throw new Error(ins.error.message);
        const shareId = (ins.data as Row).id;
        const fwd = !!body.forward_allowed;
        const rows = ids.map((id) => ({ share_id: shareId, recipient_employee_id: id, recipient_email: lc(empById(id)!.portal_email), via: via.get(id), forward_allowed: fwd }));
        const rr = await db.from("erp_file_share_recipients").insert(rows).select("id,recipient_employee_id,recipient_email");
        if (rr.error) { await db.from("erp_file_shares").delete().eq("id", shareId); throw new Error(rr.error.message); }
        // One Notification Center entry per recipient (realtime → toast on open pages).
        const n = chosen.length;
        const notes = ((rr.data || []) as Row[]).map((r) => ({
          recipient_email: r.recipient_email, recipient_employee_id: r.recipient_employee_id, type: "file_shared",
          title: "New file shared", message: `${myName} sent you “${title}”${n > 1 ? ` · ${n} files` : ""}.`,
          entity_type: "file_share", entity_id: r.id, dedupe_key: `share:${r.id}`, link: `share:${r.id}`,
          metadata: { title, by: myName, files: n, department: deptName(c.me.division || "") },
        }));
        for (let k = 0; k < notes.length; k += 100) {
          await db.from("erp_notifications").upsert(notes.slice(k, k + 100), { onConflict: "recipient_email,dedupe_key", ignoreDuplicates: true }).then(() => {}, (e: unknown) => console.warn("[share] notify:", e));
        }
        return out(req, 200, { ok: true, share_id: shareId, recipients: ids.length, files: n });
      }

      case "inbox": {
        const r = await db.from("erp_file_share_recipients").select("id,share_id,forward_allowed,viewed_at,downloaded_at,created_at").eq("recipient_employee_id", c.me.id).order("created_at", { ascending: false }).limit(300);
        if (r.error) throw new Error(r.error.message);
        const rs = (r.data || []) as Row[];
        const sids = [...new Set(rs.map((x) => x.share_id))];
        const shares: Record<string, Row> = {};
        for (let k = 0; k < sids.length; k += 150) {
          const s = await db.from("erp_file_shares").select("id,title,item_type,approved_at,files,sender_employee_id,sender_name,sender_division,message,created_at").in("id", sids.slice(k, k + 150));
          ((s.data || []) as Row[]).forEach((x) => { shares[x.id] = x; });
        }
        const items = rs.filter((x) => shares[x.share_id]).map((x) => {
          const s = shares[x.share_id], snd = empById(s.sender_employee_id);
          return { rid: x.id, title: s.title, item_type: s.item_type, approved_at: s.approved_at, message: s.message, sent_at: s.created_at,
            from: { name: s.sender_name, department: deptName(s.sender_division || ""), photo_url: snd?.photo_url || null },
            files: publicFiles(s.files), forward_allowed: x.forward_allowed, viewed_at: x.viewed_at, downloaded_at: x.downloaded_at };
        });
        return out(req, 200, { items, unread: items.filter((i) => !i.viewed_at).length });
      }

      case "open": {
        const m = await mine(body.rid);
        if (!m) return out(req, 404, { error: "That shared item is no longer available." });
        const now = new Date().toISOString();
        if (!m.r.viewed_at) { await db.from("erp_file_share_recipients").update({ viewed_at: now }).eq("id", m.r.id).is("viewed_at", null); m.r.viewed_at = now; }
        await db.from("erp_notifications").update({ read_at: now }).eq("recipient_email", lc(c.auth.email)).eq("dedupe_key", `share:${m.r.id}`).is("read_at", null).then(() => {}, () => {});
        const files = ((m.s.files || []) as Row[]).map((f, i) => { const e = { name: f.name, url: f.url, folder: !!f.folder }; return { index: i, name: f.name, kind: f.kind || "file", group: f.group || null, view: viewHref(e), downloadable: !!downloadHref(e) }; });
        return out(req, 200, { ok: true, rid: m.r.id, viewed_at: m.r.viewed_at, downloaded_at: m.r.downloaded_at, files });
      }

      case "file": {
        const m = await mine(body.rid);
        if (!m) return out(req, 404, { error: "That shared item is no longer available." });
        const f = ((m.s.files || []) as Row[])[Number(body.index)];
        if (!f) return out(req, 404, { error: "That file is not part of this share." });
        const e = { name: f.name, url: f.url, folder: !!f.folder };
        const href = downloadHref(e);
        const now = new Date().toISOString();
        await db.from("erp_file_share_recipients").update({ downloaded_at: m.r.downloaded_at || now, viewed_at: m.r.viewed_at || now }).eq("id", m.r.id);
        return out(req, 200, { ok: true, href: href || viewHref(e), direct: !!href, name: f.name });
      }

      case "sent": {
        const s = await db.from("erp_file_shares").select("id,title,item_type,files,message,created_at,source_type").eq("sender_employee_id", c.me.id).order("created_at", { ascending: false }).limit(150);
        if (s.error) throw new Error(s.error.message);
        const shares = (s.data || []) as Row[];
        const ids = shares.map((x) => x.id), rc: Row[] = [];
        for (let k = 0; k < ids.length; k += 100) {
          const r = await db.from("erp_file_share_recipients").select("share_id,recipient_employee_id,via,viewed_at,downloaded_at").in("share_id", ids.slice(k, k + 100));
          rc.push(...((r.data || []) as Row[]));
        }
        const items = shares.map((x) => ({
          id: x.id, title: x.title, item_type: x.item_type, message: x.message, sent_at: x.created_at, forwarded: x.source_type === "forward",
          files: publicFiles(x.files),
          recipients: rc.filter((r) => r.share_id === x.id).map((r) => {
            const e = empById(r.recipient_employee_id);
            return { name: e?.full_name || "Former employee", role: e ? (roleLabel(c, e) || deptName(e.division || "")) : "", status: r.downloaded_at ? "downloaded" : r.viewed_at ? "viewed" : "unread", at: r.downloaded_at || r.viewed_at || null };
          }).sort((a, b) => a.name.localeCompare(b.name)),
        }));
        return out(req, 200, { items });
      }
    }
    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("[share]", body.action, e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /erp_file_share|relation|schema cache/i.test(e.message)
      ? "File sharing needs the database update 20261103_file_shares.sql." : "Something went wrong. Please try again.";
    return out(req, 500, { error: msg });
  }
});
