// What goes into a monthly archive — pure helpers (no I/O), shared by preview and create so the
// preview the user confirms is exactly what gets archived.
// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const isMonth = (m: unknown): m is string => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const istDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));

/** Completion day (Asia/Kolkata): completed_at, else submitted_at, else the assigned date. */
export function completedOn(t: Row): string | null {
  const ts = t.completed_at || t.submitted_at;
  if (ts && !isNaN(Date.parse(ts))) return istDay(ts);
  return t.assigned_date ? String(t.assigned_date).slice(0, 10) : null;
}

/** asset_link "name|url;;name|url" (legacy: comma separated plain urls). */
export function parseAssets(s: unknown): { name: string; url: string }[] {
  const raw = String(s || "").trim();
  if (!raw) return [];
  const parts = raw.includes(";;") ? raw.split(";;") : raw.split(",");
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
    const k = p.indexOf("|");
    return k > -1 ? { name: p.slice(0, k).trim(), url: p.slice(k + 1).trim() } : { name: "", url: p };
  }).filter((x) => /^https?:\/\//i.test(x.url));
}

export function classify(url: string): { kind: "drive_file" | "drive_folder" | "storage" | "link"; driveId?: string } {
  let m = url.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]{10,})/);
  if (m) return { kind: "drive_folder", driveId: m[1] };
  m = url.match(/(?:drive|docs)\.google\.com\/(?:file|document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/([\w-]{10,})/)
    || url.match(/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/);
  if (m) return { kind: "drive_file", driveId: m[1] };
  if (/\/storage\/v1\/object\/(public|sign)\//.test(url)) return { kind: "storage" };
  return { kind: "link" };
}

export function noOutput(t: Row): boolean {
  if (t.no_output === true) return true;
  return (Array.isArray(t.history) ? t.history : []).some((h: Row) => h && h.action === "submitted" && h.no_output);
}

export async function keyOf(url: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(d)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ArchiveItem {
  assignment_id: number; project_key: string; project_title: string; category: string; creator: string;
  completed_on: string | null; deliverable_name: string; source_url: string | null; file_key: string;
  kind: string; status: string; drive_id?: string; topic: string; approved: boolean;
}

/** Completed media work of `month`, one entry per deliverable, grouped by project id. */
export async function collect(rows: Row[], projects: Record<string, Row>, month: string) {
  const items: ArchiveItem[] = [];
  for (const t of rows) {
    if (t.status !== "Completed" || t.scope === "org") continue;
    const day = completedOn(t);
    if (!day || day.slice(0, 7) !== month) continue;
    const pkey = t.project_id ? String(t.project_id) : "task-" + t.id;
    const ptitle = (t.project_id && projects[t.project_id]?.title) || t.topic || "Untitled work";
    const base = { assignment_id: Number(t.id), project_key: pkey, project_title: String(ptitle), category: t.type || "—", creator: t.assigned_to || t.employee_email || "—", completed_on: day, topic: t.topic || "", approved: !!t.manager_approved };
    const assets = parseAssets(t.asset_link);
    const files = assets.filter((a) => a.name !== "__folder__");
    // A folder delivery lists its files too — archive the files; the folder only when it's all there is.
    const use = files.length ? files : assets.filter((a) => a.name === "__folder__").map((a) => ({ name: (t.topic || "Delivery") + " (folder)", url: a.url }));
    const seen = new Set<string>();
    for (const a of use) {
      if (seen.has(a.url)) continue; seen.add(a.url);
      const c = classify(a.url);
      items.push({ ...base, deliverable_name: a.name || (t.deliverable || t.topic || "Deliverable"), source_url: a.url, file_key: await keyOf(a.url),
        kind: c.kind, status: c.kind === "link" ? "link" : "pending", drive_id: c.driveId });
    }
    if (!use.length) {
      const no = noOutput(t);
      items.push({ ...base, deliverable_name: t.deliverable || t.topic || "Deliverable", source_url: null, file_key: no ? "no-output" : "missing",
        kind: no ? "no_output" : "missing", status: no ? "no_output" : "missing" });
    }
  }
  return items;
}

/** Preview shape: projects with their deliverables + totals. */
export function summarize(items: Row[]) {
  const by: Record<string, Row> = {};
  for (const it of items) {
    const p = by[it.project_key] || (by[it.project_key] = { key: it.project_key, title: it.project_title, is_project: !String(it.project_key).startsWith("task-"), deliverables: [], missing: 0, files: 0, completed_on: it.completed_on });
    p.deliverables.push({ id: it.id || null, assignment_id: it.assignment_id, name: it.deliverable_name, category: it.category, creator: it.creator, completed_on: it.completed_on,
      kind: it.kind, status: it.status, url: it.source_url, drive_url: it.drive_url || null, error: it.error || null, approved: it.approved });
    if (it.kind === "missing") p.missing++;
    if (["drive_file", "drive_folder", "storage"].includes(it.kind)) p.files++;
    if ((it.completed_on || "") > (p.completed_on || "")) p.completed_on = it.completed_on;
  }
  const projects = Object.values(by).sort((a, b) => String(b.completed_on || "").localeCompare(String(a.completed_on || "")));
  const count = (f: (x: Row) => boolean) => items.filter(f).length;
  return {
    projects,
    totals: {
      projects: projects.length,
      files: count((x) => ["drive_file", "drive_folder", "storage"].includes(x.kind)),
      links: count((x) => x.kind === "link"),
      missing: count((x) => x.kind === "missing"),
      no_output: count((x) => x.kind === "no_output"),
      projects_missing: projects.filter((p) => p.missing > 0).length,
      done: count((x) => x.status === "done"),
      failed: count((x) => x.status === "failed"),
      pending: count((x) => x.status === "pending"),
    },
  };
}
