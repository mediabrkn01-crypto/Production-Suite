// googleAuthService — server-side Google OAuth for the Broken English organizer account.
//
// Version 1 model: ONE authorised organisation Google account (e.g. academics@…) owns every
// class event; trainers and students are attendees. Its OAuth refresh token is stored in
// public.academic_meet_config (no browser access — RLS has no policies) after a one-time
// "Connect Google account" from Live Classes, or can be supplied as the GOOGLE_REFRESH_TOKEN
// secret instead. Nothing here is ever sent to the browser.
//
// Later (Google Workspace): swap getAccessToken() for a service account with domain-wide
// delegation (impersonating the organizer or each trainer) — callers only ever ask this module
// for an access token, so nothing else changes.
//
// Secrets:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth 2.0 "Web application" client
//   GOOGLE_REDIRECT_URI     optional; default <SUPABASE_URL>/functions/v1/academic-meet?action=oauth_callback
//   GOOGLE_REFRESH_TOKEN    optional; overrides the stored token
//   GOOGLE_CALENDAR_ID      optional; overrides the stored calendar (default "primary")
//   GOOGLE_ORGANIZER_EMAIL  optional; display only
//   ACADEMIC_MEET_REVIEW_EMAIL optional; overrides the review email set in Live Classes → Settings
import { adminClient } from "../jarvis/auth.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { decryptToken, encryptToken, encryptionReady } from "./tokenCrypto.ts";

const env = (k: string, d = ""): string => (Deno.env.get(k) ?? d).trim();

// Central (fallback) organizer account. Least privilege: the same set a trainer grants —
// identity (to record which account is connected), class events, and the Meet spaces this app
// creates. No read access to the rest of the calendar.
export const GOOGLE_SCOPES = [
  "openid", "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  // Manage members of the class Meet spaces (trainer = COHOST). Spaces are owned by the organizer.
  "https://www.googleapis.com/auth/meetings.space.created",
];

export const googleConfig = {
  clientId: env("GOOGLE_CLIENT_ID"),
  clientSecret: env("GOOGLE_CLIENT_SECRET"),
  redirectUri: env("GOOGLE_REDIRECT_URI") || `${env("SUPABASE_URL")}/functions/v1/academic-meet?action=oauth_callback`,
};

export class GoogleApiError extends Error {
  constructor(public status: number, message: string, public reason = "") { super(message); }
}

export interface OrganizerConfig {
  organizerEmail: string | null;
  calendarId: string;
  refreshToken: string | null;
  defaultReminders: number[];
  /** Always invited to every class event (Academic review / monitoring). Empty = none. */
  reviewEmail: string | null;
}

/** The central account's refresh token is stored encrypted ("v1:…"). A value saved earlier in
 *  plain text is used once and re-saved encrypted, so no plain token stays in the database. */
async function storedToken(v: unknown): Promise<string | null> {
  const t = typeof v === "string" ? v : "";
  if (!t) return null;
  if (t.startsWith("v1:")) return decryptToken(t);
  if (encryptionReady()) {
    await adminClient().from("academic_meet_config").update({ refresh_token: await encryptToken(t) }).eq("id", 1).eq("refresh_token", t).then(() => {}, () => {});
  }
  return t;
}

export async function loadOrganizer(): Promise<OrganizerConfig> {
  const { data } = await adminClient().from("academic_meet_config").select("*").eq("id", 1).maybeSingle();
  return {
    organizerEmail: env("GOOGLE_ORGANIZER_EMAIL") || data?.organizer_email || null,
    calendarId: env("GOOGLE_CALENDAR_ID") || data?.calendar_id || "primary",
    refreshToken: env("GOOGLE_REFRESH_TOKEN") || await storedToken(data?.refresh_token),
    defaultReminders: Array.isArray(data?.default_reminders) && data.default_reminders.length ? data.default_reminders : [30],
    // ACADEMIC_MEET_REVIEW_EMAIL (secret) overrides the Live Classes → Settings value.
    reviewEmail: (env("ACADEMIC_MEET_REVIEW_EMAIL") || data?.review_email || "").trim().toLowerCase() || null,
  };
}

let cached: { token: string; exp: number; rt: string } | null = null;

// ── Whose Google account? ───────────────────────────────────────────────────────────────
// Every Google call runs as the account that owns the class meeting: the trainer's own
// connected Google account, or the central organizer (fallback / settings). runAs() sets it for
// everything inside (Calendar, Meet, reports) without threading a token through every function.
export interface GoogleActor { kind: "trainer" | "org"; key: string; email: string | null; employeeId?: string; refreshToken?: string }
const actorStore = new AsyncLocalStorage<GoogleActor>();
export const currentActor = (): GoogleActor => actorStore.getStore() || { kind: "org", key: "org", email: null };
export function runAs<T>(actor: GoogleActor, fn: () => Promise<T>): Promise<T> { return actorStore.run(actor, fn); }

const tokenCache = new Map<string, { token: string; exp: number }>();
/** Access token for a trainer's refresh token (cached until shortly before expiry). */
async function tokenForRefresh(rt: string, onRevoked?: () => Promise<void>): Promise<string> {
  const hit = tokenCache.get(rt);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: googleConfig.clientId, client_secret: googleConfig.clientSecret, refresh_token: rt, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    if (j.error === "invalid_grant" && onRevoked) await onRevoked().catch(() => {});
    throw new GoogleApiError(r.status || 500, j.error === "invalid_grant"
      ? "The trainer's Google access was removed or expired — the trainer needs to connect Google again."
      : `Google sign-in failed: ${j.error_description || j.error || r.status}`, j.error === "invalid_grant" ? "TRAINER_NOT_CONNECTED" : "AUTH_FAILED");
  }
  tokenCache.set(rt, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

export async function getAccessToken(): Promise<string> {
  const actor = actorStore.getStore();
  if (actor && actor.kind === "trainer") {
    if (!actor.refreshToken) throw new GoogleApiError(409, "The trainer's Google account is not connected.", "TRAINER_NOT_CONNECTED");
    return tokenForRefresh(actor.refreshToken, async () => {
      await adminClient().from("employee_google_connections").update({ connection_status: "revoked", last_error: "Google access removed or expired", updated_at: new Date().toISOString() }).eq("employee_id", actor.employeeId);
    });
  }
  if (!googleConfig.clientId || !googleConfig.clientSecret) throw new GoogleApiError(503, "Google is not set up yet — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing.", "NOT_CONFIGURED");
  const org = await loadOrganizer();
  if (!org.refreshToken) throw new GoogleApiError(503, "The Broken English Google account is not connected yet.", "NOT_CONNECTED");
  if (cached && cached.rt === org.refreshToken && cached.exp > Date.now() + 60_000) return cached.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: googleConfig.clientId, client_secret: googleConfig.clientSecret, refresh_token: org.refreshToken, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const reason = j.error === "invalid_grant" ? "NOT_CONNECTED" : "AUTH_FAILED";
    throw new GoogleApiError(r.status || 500, j.error === "invalid_grant"
      ? "Google access was revoked or expired — reconnect the Broken English Google account."
      : `Google sign-in failed: ${j.error_description || j.error || r.status}`, reason);
  }
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, rt: org.refreshToken };
  return j.access_token;
}

export function consentUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: googleConfig.clientId, redirect_uri: googleConfig.redirectUri, response_type: "code",
    scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}

/** Trainer's own account: create events + Meet rooms in THEIR calendar, and read their identity. */
export const TRAINER_SCOPES = [
  "openid", "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
];
export function trainerConsentUrl(state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: googleConfig.clientId, redirect_uri: googleConfig.redirectUri, response_type: "code",
    scope: TRAINER_SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}
/** Google account id + email of an access token's owner (OpenID userinfo). */
export async function userInfo(accessToken: string): Promise<{ sub: string; email: string }> {
  const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.email) throw new GoogleApiError(r.status || 500, "Google did not share the account email — connect again and allow access.");
  return { sub: String(j.sub || ""), email: String(j.email).trim().toLowerCase() };
}
export async function revokeToken(token: string) {
  await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {});
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: googleConfig.clientId, client_secret: googleConfig.clientSecret, code, redirect_uri: googleConfig.redirectUri, grant_type: "authorization_code" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new GoogleApiError(r.status || 500, j.error_description || j.error || "Google did not return a refresh token — remove the app's access in the Google account and connect again.");
  cached = null;
  return { refreshToken: j.refresh_token, accessToken: j.access_token, scope: String(j.scope || "") };
}

/** JSON request to a Google API with the organizer's token. Throws GoogleApiError with Google's own message. */
export async function gfetch(url: string, init: RequestInit = {}, token?: string): Promise<any> {
  const t = token || await getAccessToken();
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (r.status === 204) return null;
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!r.ok) {
    const e = j?.error;
    throw new GoogleApiError(r.status, (e && (e.message || e.status)) || text.slice(0, 200) || `Google API error ${r.status}`, e?.errors?.[0]?.reason || e?.status || "");
  }
  return j;
}
