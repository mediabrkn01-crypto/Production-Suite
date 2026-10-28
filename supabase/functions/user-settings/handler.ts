// user-settings handler (index.ts serves it) — POST /functions/v1/user-settings — an employee's own personal UI settings (Settings → Appearance).
// Deploy with --no-verify-jwt; the caller is identified ONLY by their ERP session token
// (x-erp-session), like Leave docs / Share / Aura. No employee id is ever read from the body.
//
//   {action:"get"}                         my settings + 24 h signed URLs for my background images
//   {action:"upload", name, size, type}    one-time signed upload URL into the PRIVATE bucket
//                                          erp-backgrounds at <my employee id>/<uuid>.<ext>
//   {action:"save", background}            validate + store my background preferences; every image
//                                          path must be mine and a real JPEG / PNG / WebP ≤ 8 MB.
//                                          My images no longer referenced are deleted.
//   {action:"discard", paths}              delete my own uploads that were never saved (Cancel)
//
// Data: public.erp_user_settings (RLS on, no policies — service role only) and the private
// erp-backgrounds bucket (20261112_user_settings_backgrounds.sql).
import { adminClient, JarvisAuthError, resolveAuthContext } from "../_shared/jarvis/auth.ts";

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
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const BUCKET = "erp-backgrounds";
export const MAX = 8 * 1024 * 1024;
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MODES = ["black", "white", "image"];
const FITS = ["cover", "contain", "auto", "tile"];
const POS = ["center", "top", "bottom", "left", "right", "top left", "top right", "bottom left", "bottom right"];
const extOf = (n: string) => (String(n).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || "";
const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** One theme's preference, normalised. Throws a user-facing message for an image that isn't mine. */
export function cleanPref(p: Row | null | undefined, theme: "dark" | "light", me: string): Row {
  p = p && typeof p === "object" ? p : {};
  const mode = MODES.includes(p.mode) ? p.mode : (theme === "dark" ? "black" : "white");
  const pref: Row = {
    mode,
    fit: FITS.includes(p.fit) ? p.fit : "cover",
    pos: POS.includes(p.pos) ? p.pos : "center",
    blur: clampInt(p.blur, 0, 24, 0),
    overlay: clampInt(p.overlay, 0, 80, 25),
  };
  if (mode === "image") {
    const path = String(p.path || "");
    if (!path.startsWith(me + "/") || path.includes("..") || !TYPES[extOf(path)]) throw new Error("That background image isn't one of your uploads.");
    pref.path = path;
  }
  return pref;
}

/** Real image bytes, not just a name: JPEG / PNG / WebP signatures. */
export function sniff(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// deno-lint-ignore no-explicit-any
async function myFiles(db: any, me: string): Promise<string[]> {
  const r = await db.storage.from(BUCKET).list(me, { limit: 200 });
  if (r.error) throw new Error(r.error.message);
  return (r.data || []).filter((o: Row) => o.name && o.id).map((o: Row) => `${me}/${o.name}`);
}
// deno-lint-ignore no-explicit-any
async function signAll(db: any, bg: Row): Promise<Record<string, string>> {
  const paths = [...new Set(["dark", "light"].map((t) => bg?.[t]?.mode === "image" ? bg[t].path : null).filter(Boolean))] as string[];
  if (!paths.length) return {};
  const r = await db.storage.from(BUCKET).createSignedUrls(paths, 86400);
  if (r.error) throw new Error(r.error.message);
  const urls: Record<string, string> = {};
  for (const s of r.data || []) if (s.signedUrl && s.path) urls[s.path] = s.signedUrl;
  return urls;
}
// deno-lint-ignore no-explicit-any
const missingTable = (e: any) => /erp_user_settings|relation .* does not exist|schema cache/i.test(String(e?.message || e));

export async function handle(req: Request, deps: { auth?: (r: Request) => Promise<Row>; db?: Row } = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let auth;
  try { auth = await (deps.auth || resolveAuthContext)(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[user-settings] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = deps.db || adminClient();
  const me = String(auth.employeeId || "");
  if (!me) return out(req, 403, { error: "No employee profile is linked to this sign-in." });

  try {
    switch (body.action) {
      case "get": {
        const r = await db.from("erp_user_settings").select("settings").eq("employee_id", me).maybeSingle();
        if (r.error) { if (missingTable(r.error)) return out(req, 503, { error: "Background images need a one-time database update.", code: "SETUP_PENDING" }); throw new Error(r.error.message); }
        const bg = (r.data?.settings || {}).background || null;
        return out(req, 200, { background: bg, urls: bg ? await signAll(db, bg) : {} });
      }

      case "upload": {
        const name = String(body.name || "").trim(), size = Number(body.size || 0), ext = extOf(name);
        if (!TYPES[ext]) return out(req, 400, { error: "Use a JPG, PNG or WebP image." });
        if (body.type && String(body.type) !== TYPES[ext] && !(ext === "jpg" && body.type === "image/jpeg")) return out(req, 400, { error: "That file isn't a JPG, PNG or WebP image." });
        if (!(size > 0)) return out(req, 400, { error: "That file is empty." });
        if (size > MAX) return out(req, 400, { error: "That image is larger than 8 MB." });
        const path = `${me}/${crypto.randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
        const r = await db.storage.from(BUCKET).createSignedUploadUrl(path);
        if (r.error) { if (/bucket/i.test(r.error.message)) return out(req, 503, { error: "Background images need a one-time database update.", code: "SETUP_PENDING" }); throw new Error(r.error.message); }
        return out(req, 200, { path, url: r.data.signedUrl, type: TYPES[ext] });
      }

      case "save": {
        const src = body.background && typeof body.background === "object" ? body.background : {};
        let bg: Row;
        try { bg = { same: !!src.same, dark: cleanPref(src.dark, "dark", me), light: cleanPref(src.same ? src.dark : src.light, "light", me) }; }
        catch (e) { return out(req, 403, { error: (e as Error).message }); }
        if (bg.same) bg.light = { ...bg.dark, mode: bg.dark.mode };
        // every referenced image must exist, be mine, and really be an image within the limit
        const used = [...new Set([bg.dark, bg.light].filter((p) => p.mode === "image").map((p) => p.path))] as string[];
        for (const path of used) {
          const d = await db.storage.from(BUCKET).download(path);
          if (d.error || !d.data) return out(req, 400, { error: "The uploaded image could not be found — upload it again." });
          const buf = new Uint8Array(await d.data.arrayBuffer());
          if (buf.length > MAX) return out(req, 400, { error: "That image is larger than 8 MB." });
          if (!sniff(buf.slice(0, 16))) { await db.storage.from(BUCKET).remove([path]); return out(req, 400, { error: "That file isn't a valid JPG, PNG or WebP image." }); }
        }
        const prev = await db.from("erp_user_settings").select("settings").eq("employee_id", me).maybeSingle();
        if (prev.error) { if (missingTable(prev.error)) return out(req, 503, { error: "Background images need a one-time database update.", code: "SETUP_PENDING" }); throw new Error(prev.error.message); }
        const settings = { ...(prev.data?.settings || {}), background: bg };
        const w = await db.from("erp_user_settings").upsert({ employee_id: me, settings, updated_at: new Date().toISOString() }, { onConflict: "employee_id" });
        if (w.error) throw new Error(w.error.message);
        // tidy: my images that no saved preference points at any more
        try { const stale = (await myFiles(db, me)).filter((p) => !used.includes(p)); if (stale.length) await db.storage.from(BUCKET).remove(stale); } catch (e) { console.warn("[user-settings] cleanup:", (e as Error).message); }
        return out(req, 200, { background: bg, urls: await signAll(db, bg) });
      }

      case "discard": {
        const paths = (Array.isArray(body.paths) ? body.paths : []).map(String).filter((p: string) => p.startsWith(me + "/") && !p.includes(".."));
        if (!paths.length) return out(req, 200, { ok: true });
        const cur = await db.from("erp_user_settings").select("settings").eq("employee_id", me).maybeSingle();
        const bg = cur.data?.settings?.background || {};
        const keep = new Set([bg.dark?.path, bg.light?.path].filter(Boolean));
        const del = paths.filter((p: string) => !keep.has(p));
        if (del.length) { const r = await db.storage.from(BUCKET).remove(del); if (r.error) throw new Error(r.error.message); }
        return out(req, 200, { ok: true, removed: del.length });
      }

      default:
        return out(req, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error("[user-settings]", body.action, e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Your settings couldn't be saved right now. Try again." });
  }
}

