// ERP session tokens — issued by the `erp-session` function when someone signs in through the
// normal Broken English login, and verified by Jarvis on every request.
//
//   token = base64url(payload JSON) "." base64url(HMAC-SHA256(payload))
//   payload = { v: 1, sub: "<portal email>", iat, exp }   (seconds)
//
// The signing key is derived from this project's service-role key, which never leaves the
// server, so no extra secret has to be managed. The token carries identity ONLY — access is
// re-resolved from HR on every request, so role changes and deactivation apply immediately.
import { config } from "./config.ts";

const SESSION_DAYS = 30; // same window as the ERP's own "stay signed in"

function b64url(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}

let _key: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (!_key) {
    _key = (async () => {
      const secret = Deno.env.get("ERP_SESSION_SECRET") || config.serviceRoleKey;
      if (!secret) throw new Error("no session signing secret");
      const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("be-erp-session|v1|" + secret));
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
  }
  return _key;
}

export async function signSession(email: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000), exp = now + SESSION_DAYS * 86400;
  const body = b64url(new TextEncoder().encode(JSON.stringify({ v: 1, sub: email.trim().toLowerCase(), iat: now, exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(body)));
  return { token: body + "." + b64url(sig), exp };
}

/** Returns the signed-in email, or null when the token is missing, forged or expired. */
export async function verifySession(token: string | null | undefined): Promise<{ email: string; exp: number } | null> {
  if (!token || token.length > 2048) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(), unb64url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (p.v !== 1 || typeof p.sub !== "string" || typeof p.exp !== "number") return null;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return { email: p.sub, exp: p.exp };
  } catch {
    return null;
  }
}
