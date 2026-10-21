// POST /functions/v1/leave-docs — supporting documents for leave requests (medical certificates,
// prescriptions, proof). Deploy with --no-verify-jwt; the caller is identified by their ERP
// session token (x-erp-session), like Calendar / Aura / Share.
//
//   {action:"upload", name, size, type}        one-time signed upload URL into the PRIVATE bucket
//                                              leave-docs, at <my employee id>/<YYYY-MM>/<uuid>-<name>
//   {action:"remove", path}                    delete my own file that isn't attached to a request yet
//   {action:"sign", request_id, path, download?}  2-minute signed URL to view / download an attached
//                                              file — only for the employee who asked for the leave,
//                                              HR, and leadership
//
// Files never get a public URL. The bucket is private and excluded from the project's catch-all
// storage policies (20261106), so the browser key can't list or read it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
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

const BUCKET = "leave-docs";
const MAX = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const extOf = (n: string) => (String(n).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || "";
const safeName = (n: string) => String(n || "document").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-80) || "document";
const ymIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return out(req, 405, { error: "Use POST." });
  let auth;
  try { auth = await resolveAuthContext(req); } catch (e) {
    if (e instanceof JarvisAuthError) return out(req, e.status, { error: e.code === "SESSION_EXPIRED" ? e.message.replace(/ to continue using Jarvis/, "") : e.message, code: e.code });
    console.error("[leave-docs] auth:", e instanceof Error ? e.message : e);
    return out(req, 500, { error: "Could not verify your sign-in right now." });
  }
  let body: Row = {};
  try { body = await req.json(); } catch { return out(req, 400, { error: "Bad request." }); }
  const db = adminClient();
  const me = auth.employeeId;
  // HR (HR division / HR admin / payroll access) and leadership may open anyone's leave documents.
  const reviewer = auth.permissions.includes("hr.attendance") || auth.permissions.includes("hr.payroll") || auth.permissions.includes("org");

  try {
    switch (body.action) {
      case "upload": {
        const name = String(body.name || "").trim(), size = Number(body.size || 0), ext = extOf(name);
        const type = TYPES[ext];
        if (!type) return out(req, 400, { error: "Use a photo (JPG, PNG, HEIC) or a PDF / Word document." });
        if (!(size > 0)) return out(req, 400, { error: "That file is empty." });
        if (size > MAX) return out(req, 400, { error: "That file is larger than 20 MB." });
        const path = `${me}/${ymIst()}/${crypto.randomUUID()}-${safeName(name)}`;
        const r = await db.storage.from(BUCKET).createSignedUploadUrl(path);
        if (r.error) throw new Error(r.error.message);
        return out(req, 200, { path, url: r.data.signedUrl, type });
      }

      case "remove": {
        const path = String(body.path || "");
        if (!path.startsWith(me + "/")) return out(req, 403, { error: "You can only remove your own uploads." });
        const used = await db.from("hr_leave_requests").select("id").contains("proof_files", [{ path }]).limit(1);
        if (used.data && used.data.length) return out(req, 409, { error: "This document is already attached to a submitted request." });
        const r = await db.storage.from(BUCKET).remove([path]);
        if (r.error) throw new Error(r.error.message);
        return out(req, 200, { ok: true });
      }

      case "sign": {
        const path = String(body.path || "");
        const q = await db.from("hr_leave_requests").select("id,employee_id,proof_files").eq("id", body.request_id).maybeSingle();
        if (!q.data) return out(req, 404, { error: "That leave request no longer exists." });
        const r0 = q.data as Row;
        if (!(r0.employee_id === me || reviewer)) return out(req, 403, { error: "You can't open documents of this leave request." });
        const f = ((r0.proof_files || []) as Row[]).find((x) => x && x.path === path);
        // The file must belong to THIS request and live in the requesting employee's folder.
        if (!f || !path.startsWith(String(r0.employee_id) + "/")) return out(req, 404, { error: "That document is not attached to this request." });
        const s = await db.storage.from(BUCKET).createSignedUrl(path, 120, body.download ? { download: String(f.name || "document") } : undefined);
        if (s.error) throw new Error(s.error.message);
        return out(req, 200, { url: s.data.signedUrl, name: f.name, type: f.type || TYPES[extOf(f.name || path)] || "" });
      }
    }
    return out(req, 400, { error: "Unknown action." });
  } catch (e) {
    console.error("[leave-docs]", body.action, e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /bucket|not found|proof_files|schema cache/i.test(e.message)
      ? "Leave documents need the database update 20261106_leave_documents.sql." : "Something went wrong. Please try again.";
    return out(req, 500, { error: msg });
  }
});
