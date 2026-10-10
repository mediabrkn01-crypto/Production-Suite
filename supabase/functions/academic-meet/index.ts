// academic-meet — Academic → Live Classes backend (Google Calendar + Google Meet).
//
// Auth: the normal ERP sign-in. The browser sends the signed ERP session token (BESession) as
// `x-erp-session`; access is re-resolved from HR on every request (same rules as the ERP):
//   Academic Head / Class Coordinator / Operations Manager → create, edit, cancel, invite
//   Manager / Founder (organisation-wide Academic read)    → view all
//   Fluency Coach / trainer                                → own classes only
// Google credentials never leave the server.
//
// POST JSON { action, key?, start?, reason?, reminders? }
//   status | details | create | update | cancel | resend | retry | oauth_url | set_reminders
// GET ?action=oauth_callback   — Google's redirect after "Connect Google account"
//
// Deploy with --no-verify-jwt (Google's OAuth redirect carries no Supabase JWT; every other call
// is authorised by the ERP session token above).
import { resolveAuthContext, JarvisAuthError, adminClient, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { signSession, verifySession } from "../_shared/jarvis/session.ts";
import { consentUrl, exchangeCode, googleConfig, GoogleApiError, loadOrganizer } from "../_shared/google/googleAuthService.ts";
import { calendarIdentity } from "../_shared/google/googleCalendarService.ts";
import {
  canManage, cancelClassMeeting, createClassMeeting, getMeetingDetails, MeetError, resendInvitations,
  retryCancel, retrySync, updateClassMeeting,
} from "./academicMeetService.ts";
import { can } from "../_shared/jarvis/auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-erp-session",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SESSION_EXPIRED = "Your session has expired. Please sign in again to continue.";

const page = (title: string, msg: string, ok: boolean) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#030509;color:#f1f5f9;font:15px/1.5 Inter,system-ui,sans-serif">
<div style="max-width:420px;padding:28px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(13,17,28,.8);text-align:center">
<div style="font-size:28px;margin-bottom:8px;color:${ok ? "#10b981" : "#f87171"}">${ok ? "✓" : "!"}</div>
<h1 style="font-size:18px;margin:0 0 8px">${title}</h1><p style="margin:0;color:#94a3b8">${msg}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'be-academic-meet-oauth',ok:${ok}},'*')}catch(e){}</script>`,
  { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
);

async function oauthCallback(url: URL): Promise<Response> {
  const err = url.searchParams.get("error");
  if (err) return page("Google not connected", `Google returned: ${err}. Close this tab and try again from Live Classes.`, false);
  // state = a short-lived signed ERP token for "oauth:<email>" issued by oauth_url below.
  const st = await verifySession(url.searchParams.get("state"));
  const issuedAt = st ? st.exp - 30 * 86400 : 0;
  if (!st || !st.email.startsWith("oauth:") || Date.now() / 1000 - issuedAt > 900) return page("Link expired", "This connect link has expired. Start again from Live Classes.", false);
  const email = st.email.slice(6);
  // Re-check, server-side, that this person may still manage Live Classes.
  const tok = (await signSession(email)).token;
  let a: JarvisAuthContext;
  try { a = await resolveAuthContext(new Request("https://x", { headers: { "x-erp-session": tok } })); } catch { return page("Not allowed", "Your ERP access could not be confirmed.", false); }
  if (!canManage(a)) return page("Not allowed", "Only Academic Head, Class Coordinator or Operations Manager can connect the Google account.", false);
  try {
    const { refreshToken, accessToken } = await exchangeCode(url.searchParams.get("code") || "");
    const org = await loadOrganizer();
    const organizer = await calendarIdentity(org.calendarId, accessToken).catch(() => null);
    const { error } = await adminClient().from("academic_meet_config").upsert({
      id: 1, refresh_token: refreshToken, organizer_email: organizer, connected_by: a.email, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return page("Google account connected", `Live Classes will create Calendar events and Meet links as ${organizer || "the connected account"}. You can close this tab.`, true);
  } catch (e) {
    return page("Google not connected", (e as Error).message || "Something went wrong.", false);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("action") === "oauth_callback") return oauthCallback(url);
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  let a: JarvisAuthContext;
  try { a = await resolveAuthContext(req); }
  catch (e) {
    if (e instanceof JarvisAuthError) return json({ ok: false, code: e.code, message: e.code === "SESSION_EXPIRED" ? SESSION_EXPIRED : e.message }, e.status);
    return json({ ok: false, message: "Could not check your access." }, 500);
  }
  if (!can(a, "academic.all") && !can(a, "academic.own")) return json({ ok: false, code: "FORBIDDEN", message: "Live Classes is for the Academic team." }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const key = String(body.key || ""), hint = { start: typeof body.start === "string" ? body.start : undefined };

  try {
    switch (body.action) {
      case "status": {
        const org = await loadOrganizer();
        return json({
          ok: true, configured: !!(googleConfig.clientId && googleConfig.clientSecret), connected: !!org.refreshToken,
          organizerEmail: org.organizerEmail, calendarId: org.calendarId, defaultReminders: org.defaultReminders,
          canManage: canManage(a), canViewAll: can(a, "academic.all"), trainerId: a.trainerId,
        });
      }
      case "details": return json({ ok: true, ...(await getMeetingDetails(a, key, hint)) });
      case "create": return json({ ok: true, ...(await createClassMeeting(a, key, hint)) });
      case "update": return json({ ok: true, ...(await updateClassMeeting(a, key, hint)) });
      case "resend": return json({ ok: true, ...(await resendInvitations(a, key, hint)) });
      case "retry": {
        const { data: r } = await adminClient().from("academic_live_classes").select("class_status").eq("occurrence_key", key).maybeSingle();
        return json({ ok: true, ...(r?.class_status === "cancelled" ? await retryCancel(a, key) : await retrySync(a, key, hint)) });
      }
      case "cancel": return json({ ok: true, ...(await cancelClassMeeting(a, key, String(body.reason || "").slice(0, 300), hint)) });
      case "oauth_url": {
        if (!canManage(a)) return json({ ok: false, code: "FORBIDDEN", message: "Only Academic Head, Class Coordinator or Operations Manager can connect Google." }, 403);
        if (!googleConfig.clientId || !googleConfig.clientSecret) return json({ ok: false, code: "NOT_CONFIGURED", message: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server first." }, 503);
        const state = (await signSession("oauth:" + a.email)).token;
        return json({ ok: true, url: consentUrl(state), redirectUri: googleConfig.redirectUri });
      }
      case "set_reminders": {
        if (!canManage(a)) return json({ ok: false, code: "FORBIDDEN", message: "Not allowed." }, 403);
        const mins = (Array.isArray(body.reminders) ? body.reminders : []).map(Number).filter((m: number) => Number.isInteger(m) && m >= 0 && m <= 1440).slice(0, 2);
        if (!mins.length) return json({ ok: false, message: "Choose at least one reminder." }, 400);
        await adminClient().from("academic_meet_config").upsert({ id: 1, default_reminders: mins, updated_at: new Date().toISOString() });
        return json({ ok: true, defaultReminders: mins });
      }
      default: return json({ ok: false, message: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof MeetError) return json({ ok: false, code: e.code, message: e.message }, e.status);
    if (e instanceof GoogleApiError) return json({ ok: false, code: e.reason || "GOOGLE", message: "Google: " + e.message }, e.status >= 400 && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 502);
    console.error("academic-meet", body.action, e);
    return json({ ok: false, message: (e as Error).message || "Something went wrong." }, 500);
  }
});
