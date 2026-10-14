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
//   status | details | create | update | cancel | resend | retry | join | end | sync_report
//   oauth_url | set_reminders | set_review_email
// GET ?action=oauth_callback   — Google's redirect after "Connect Google account"
//
// Deploy with --no-verify-jwt (Google's OAuth redirect carries no Supabase JWT; every other call
// is authorised by the ERP session token above).
import { resolveAuthContext, JarvisAuthError, adminClient, type JarvisAuthContext } from "../_shared/jarvis/auth.ts";
import { signSession, verifySession } from "../_shared/jarvis/session.ts";
import { consentUrl, exchangeCode, googleConfig, GoogleApiError, loadOrganizer, runAs, trainerConsentUrl, userInfo, revokeToken, TRAINER_SCOPES } from "../_shared/google/googleAuthService.ts";
import { encryptToken, decryptToken, encryptionReady } from "../_shared/google/tokenCrypto.ts";
import { actorForKey, connectionOf, employeeOfTrainer } from "./owners.ts";
import {
  canManage, cancelClassMeeting, createClassMeeting, getMeetingDetails, MeetError, resendInvitations,
  retryCancel, retrySync, updateClassMeeting, joinLive, endClass, syncMeetReport, setTrainerEmail, openRoom,
  enqueue, processQueue, recreateWithTrainer,
} from "./academicMeetService.ts";
import { calendarPause } from "./syncGuard.ts";

/** Keep working after the response is sent (Supabase Edge Runtime background task). */
function background(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  const safe = p.catch((e) => console.error("academic-meet queue", e));
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(safe);
}
import { can } from "../_shared/jarvis/auth.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-erp-session",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SESSION_EXPIRED = "Your session has expired. Please sign in again to continue.";

// Supabase serves function responses as plain text, so the OAuth result is shown on a small page
// on the ERP site (meet-connected.html), which also notifies the Live Classes tab and closes.
const SITE_URL = (Deno.env.get("ERP_SITE_URL") || "https://work.brokenenglish.in").replace(/\/+$/, "");
const page = (title: string, msg: string, ok: boolean) => new Response(null, {
  status: 302,
  headers: { Location: `${SITE_URL}/meet-connected.html?` + new URLSearchParams({ ok: ok ? "1" : "0", t: title, m: msg }).toString() },
});

async function oauthCallback(url: URL): Promise<Response> {
  const err = url.searchParams.get("error");
  if (err) return page("Google not connected", `Google returned: ${err}. Close this tab and try again from Live Classes.`, false);
  // state = a short-lived signed ERP token for "oauth:<email>" issued by oauth_url below.
  const st = await verifySession(url.searchParams.get("state"));
  const issuedAt = st ? st.exp - 30 * 86400 : 0;
  if (!st || !(st.email.startsWith("oauth:") || st.email.startsWith("oauth-trainer:")) || Date.now() / 1000 - issuedAt > 900) return page("Link expired", "This connect link has expired. Start again from Live Classes.", false);
  if (st.email.startsWith("oauth-trainer:")) return trainerCallback(url, st.email.slice(14));
  const email = st.email.slice(6);
  // Re-check, server-side, that this person may still manage Live Classes.
  const tok = (await signSession(email)).token;
  let a: JarvisAuthContext;
  try { a = await resolveAuthContext(new Request("https://x", { headers: { "x-erp-session": tok } })); } catch { return page("Not allowed", "Your ERP access could not be confirmed.", false); }
  if (!canManage(a)) return page("Not allowed", "Only Academic Head, Class Coordinator or Operations Manager can connect the Google account.", false);
  try {
    const { refreshToken, accessToken } = await exchangeCode(url.searchParams.get("code") || "");
    const org = await loadOrganizer();
    // "primary" = the connected account itself (identity from OpenID userinfo); otherwise the
    // configured calendar id is the organizer address.
    const organizer = org.calendarId === "primary" ? (await userInfo(accessToken).catch(() => null))?.email || null : org.calendarId;
    const { error } = await adminClient().from("academic_meet_config").upsert({
      id: 1, refresh_token: await encryptToken(refreshToken), organizer_email: organizer, connected_by: a.email, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // A newly connected organizer (e.g. Google Workspace) gets co-host re-tested.
    await adminClient().from("academic_meet_config").update({ cohost_supported: null }).eq("id", 1).then(() => {}, () => {});
    if (error) throw new Error(error.message);
    return page("Google account connected", `Live Classes will create Calendar events and Meet links as ${organizer || "the connected account"}. You can close this tab.`, true);
  } catch (e) {
    return page("Google not connected", (e as Error).message || "Something went wrong.", false);
  }
}

/** A trainer connected THEIR Google account (one time). Stores the encrypted refresh token —
 *  never a password — in employee_google_connections (server-only table). */
async function trainerCallback(url: URL, erpEmail: string): Promise<Response> {
  const tok = (await signSession(erpEmail)).token;
  let a: JarvisAuthContext;
  try { a = await resolveAuthContext(new Request("https://x", { headers: { "x-erp-session": tok } })); } catch { return page("Not allowed", "Your ERP access could not be confirmed.", false); }
  const employeeId = await employeeOfTrainer(a.trainerId);
  if (!employeeId) return page("Not a trainer", "Only trainers with an Academic trainer profile linked to their HR record can connect a Google Meet account.", false);
  try {
    const { refreshToken, accessToken, scope } = await exchangeCode(url.searchParams.get("code") || "");
    const who = await userInfo(accessToken);
    const missing = TRAINER_SCOPES.filter((sc) => sc.startsWith("https://") && !scope.includes(sc));
    if (missing.length) return page("Permission missing", "Google didn't grant every permission Live Classes needs (Calendar events and Meet). Connect again and tick every box.", false);
    const { error } = await adminClient().from("employee_google_connections").upsert({
      employee_id: employeeId, trainer_id: a.trainerId, google_email: who.email, google_user_id: who.sub,
      refresh_token_encrypted: await encryptToken(refreshToken), scopes: scope, connected_at: new Date().toISOString(), connected_by: a.email,
      last_refresh_at: new Date().toISOString(), connection_status: "connected", last_error: null, paused_until: null, pause_level: 0, updated_at: new Date().toISOString(),
    }, { onConflict: "employee_id" });
    if (error) throw new Error(error.message);
    return page("Google Meet account connected", `Your classes will be created in ${who.email}'s Google Calendar — you are the host and can admit students. You can close this tab.`, true);
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

  // Every class action talks to Google AS the account that owns that class's meeting.
  const owner = key && !["create", "create_fallback", "recreate_trainer", "enqueue"].includes(body.action) ? await actorForKey(key).catch(() => null) : null;
  return owner ? runAs(owner, () => handle(a, body, key, hint)) : handle(a, body, key, hint);
});

async function handle(a: JarvisAuthContext, body: any, key: string, hint: { start?: string }): Promise<Response> {
  try {
    switch (body.action) {
      case "status": {
        const org = await loadOrganizer();
        return json({
          ok: true, configured: !!(googleConfig.clientId && googleConfig.clientSecret), connected: !!org.refreshToken,
          organizerEmail: org.organizerEmail, calendarId: org.calendarId, defaultReminders: org.defaultReminders, reviewEmail: org.reviewEmail,
          canManage: canManage(a), canViewAll: can(a, "academic.all"), trainerId: a.trainerId,
          // Google limiting the organizer — shown to the Academic team only.
          ...(canManage(a) ? { calendarPausedUntil: (await calendarPause())?.until || null } : {}),
        });
      }
      case "details": return json({ ok: true, ...(await getMeetingDetails(a, key, hint)) });
      case "create": return json({ ok: true, ...(await createClassMeeting(a, key, hint)) });
      // Explicit emergency choice by the Academic team: the central account owns it ("Fallback organizer").
      case "create_fallback": return json({ ok: true, ...(await createClassMeeting(a, key, hint, { fallback: true })) });
      case "recreate_trainer": return json({ ok: true, ...(await recreateWithTrainer(a, key, hint)) });
      // ── Trainer's own Google Meet account ──
      case "my_google": {
        const emp = await employeeOfTrainer(a.trainerId);
        const c = await connectionOf(emp);
        return json({ ok: true, isTrainer: !!emp, connected: c?.status === "connected", email: c?.email || null, status: c?.status || "not_connected", connectedAt: c?.connectedAt || null, serverReady: encryptionReady() && !!googleConfig.clientId });
      }
      case "trainer_oauth_url": {
        const emp = await employeeOfTrainer(a.trainerId);
        if (!emp) return json({ ok: false, code: "NOT_TRAINER", message: "Only trainers with an Academic trainer profile can connect a Google Meet account." }, 403);
        if (!googleConfig.clientId || !googleConfig.clientSecret) return json({ ok: false, code: "NOT_CONFIGURED", message: "Google is not set up on the server yet." }, 503);
        if (!encryptionReady()) return json({ ok: false, code: "NO_ENC_KEY", message: "The server can't store Google connections securely yet (GOOGLE_TOKEN_ENC_KEY is missing) — tell the admin." }, 503);
        const state = (await signSession("oauth-trainer:" + a.email)).token;
        return json({ ok: true, url: trainerConsentUrl(state, typeof body.hint === "string" ? body.hint : undefined) });
      }
      case "trainer_disconnect": {
        const emp = await employeeOfTrainer(a.trainerId);
        if (!emp) return json({ ok: false, code: "NOT_TRAINER", message: "Not a trainer." }, 403);
        const { data } = await adminClient().from("employee_google_connections").select("refresh_token_encrypted").eq("employee_id", emp).maybeSingle();
        if (data?.refresh_token_encrypted) { try { await revokeToken(await decryptToken(data.refresh_token_encrypted)); } catch { /* still removed below */ } }
        await adminClient().from("employee_google_connections").delete().eq("employee_id", emp);
        return json({ ok: true, connected: false });
      }
      case "trainer_connections": {
        if (!can(a, "academic.all")) return json({ ok: false, code: "FORBIDDEN", message: "Not allowed." }, 403);
        const { data: trs } = await adminClient().from("trainers").select("id,name,hr_employee_id,status");
        const { data: cs } = await adminClient().from("employee_google_connections").select("employee_id,google_email,connection_status,connected_at").then((r) => r, () => ({ data: [] as any[] }));
        const by = new Map((cs || []).map((c: any) => [c.employee_id, c]));
        return json({ ok: true, trainers: (trs || []).filter((t: any) => t.status !== "inactive").map((t: any) => {
          const c: any = t.hr_employee_id ? by.get(t.hr_employee_id) : null;
          return { trainerId: t.id, name: t.name, linked: !!t.hr_employee_id, connected: c?.connection_status === "connected", status: c?.connection_status || "not_connected", email: c?.google_email || null };
        }) });
      }
      // Bulk / automatic creation goes through the server queue: one class at a time, paced,
      // paused while Google limits the organizer. Processing continues after this response.
      case "enqueue": {
        const r = await enqueue(a, Array.isArray(body.keys) ? body.keys.map(String) : [], body.starts && typeof body.starts === "object" ? body.starts : {}, body.force === true);
        background(processQueue(a));
        return json({ ok: true, ...r });
      }
      case "process_queue": {
        if (!canManage(a)) return json({ ok: true, skipped: true });
        background(processQueue(a));
        return json({ ok: true, started: true });
      }
      case "update": return json({ ok: true, ...(await updateClassMeeting(a, key, hint)) });
      case "resend": return json({ ok: true, ...(await resendInvitations(a, key, hint)) });
      case "retry": {
        const { data: r } = await adminClient().from("academic_live_classes").select("class_status").eq("occurrence_key", key).maybeSingle();
        return json({ ok: true, ...(r?.class_status === "cancelled" ? await retryCancel(a, key) : await retrySync(a, key, hint)) });
      }
      case "set_trainer_email": return json({ ok: true, ...(await setTrainerEmail(a, key, String(body.email || ""), hint)) });
      case "open_room": return json({ ok: true, ...(await openRoom(a, key, hint)) });
      case "join": return json({ ok: true, ...(await joinLive(a, key, hint)) });
      case "end": return json({ ok: true, ...(await endClass(a, key, hint)) });
      case "sync_report": return json({ ok: true, ...(await syncMeetReport(a, key, hint)) });
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
      case "set_review_email": {
        if (!canManage(a)) return json({ ok: false, code: "FORBIDDEN", message: "Not allowed." }, 403);
        const em = String(body.email || "").trim().toLowerCase();
        if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return json({ ok: false, message: "Enter a valid email address." }, 400);
        await adminClient().from("academic_meet_config").upsert({ id: 1, review_email: em || null, updated_at: new Date().toISOString() });
        return json({ ok: true, reviewEmail: em || null });
      }
      default: return json({ ok: false, message: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof MeetError) return json({ ok: false, code: e.code, message: e.message, nextRetryAt: (e as any).nextRetryAt || null }, e.status);
    if (e instanceof GoogleApiError) return json({ ok: false, code: e.reason || "GOOGLE", message: "Google: " + e.message }, e.status >= 400 && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 502);
    console.error("academic-meet", body.action, e);
    return json({ ok: false, message: (e as Error).message || "Something went wrong." }, 500);
  }
}

