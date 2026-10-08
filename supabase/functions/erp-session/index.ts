// POST /functions/v1/erp-session — called by the normal ERP login (index.html) right after a
// successful sign-in, with the same username/email + password the person just typed. Runs the
// SAME check as the ERP login, but on the server, plus the HR access gate, and returns a signed
// session token that Jarvis (and future server features) can verify. No separate Jarvis login,
// no new user accounts.
//
//   body     { "identifier": "<email or name>", "password": "<password>" }
//   200      { "token", "exp", "email" }
//   401/403  { "error" }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient } from "../_shared/jarvis/auth.ts";
import { signSession } from "../_shared/jarvis/session.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Light brute-force brake per isolate: 10 failures / 10 min per identifier.
const fails = new Map<string, { n: number; t: number }>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  let identifier = "", password = "";
  try {
    const b = await req.json();
    identifier = String(b?.identifier || "").trim().toLowerCase().slice(0, 200);
    password = String(b?.password ?? "").trim().slice(0, 200);
  } catch { return json(400, { error: "Bad request." }); }
  if (!identifier) return json(400, { error: "Missing identifier." });
  const f = fails.get(identifier);
  if (f && f.n >= 10 && Date.now() - f.t < 600_000) return json(429, { error: "Too many attempts. Try again later." });

  const sb = adminClient();
  const { data: roster, error } = await sb.from("user_roster").select("email,name,role,pass");
  if (error) return json(503, { error: "Account registry unavailable." });
  // Same match + password rule as the ERP login (index.html portal login).
  const u = (roster || []).find((r) => String(r.email || "").trim().toLowerCase() === identifier || String(r.name || "").trim().toLowerCase() === identifier);
  const pass = String(u?.pass ?? "");
  const privileged = u && (u.role === "admin" || u.role === "manager");
  const ok = !!u && (password === pass || (!privileged && !pass));
  if (!ok) {
    fails.set(identifier, { n: (f && Date.now() - f.t < 600_000 ? f.n : 0) + 1, t: Date.now() });
    return json(401, { error: "Invalid username or password." });
  }
  fails.delete(identifier);
  const email = String(u!.email).trim().toLowerCase();
  // HR access gate (inactive / exited / portal access disabled), same RPC the ERP uses.
  const gate = await sb.rpc("portal_access_state", { p_email: email });
  if (gate.data && gate.data.allowed === false) return json(403, { error: gate.data.message || "Sign-in disabled. Contact HR." });
  const s = await signSession(email);
  return json(200, { token: s.token, exp: s.exp, email });
});
