// tokenCrypto — AES-256-GCM for OAuth refresh tokens stored in the database.
// Key: GOOGLE_TOKEN_ENC_KEY secret (base64 of 32 random bytes). Format "v1:<iv b64>:<cipher b64>".
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let keyP: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  const raw = (Deno.env.get("GOOGLE_TOKEN_ENC_KEY") || "").trim();
  if (!raw) throw new Error("GOOGLE_TOKEN_ENC_KEY is not set on the server — trainer Google connections can't be stored securely.");
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new Error("GOOGLE_TOKEN_ENC_KEY must be 32 bytes, base64-encoded.");
  return keyP ||= crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export const encryptionReady = () => { try { const r = (Deno.env.get("GOOGLE_TOKEN_ENC_KEY") || "").trim(); return !!r && unb64(r).length === 32; } catch { return false; } };

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)));
  return `v1:${b64(iv)}:${b64(c)}`;
}
export async function decryptToken(enc: string): Promise<string> {
  const [v, iv, c] = String(enc || "").split(":");
  if (v !== "v1" || !iv || !c) throw new Error("Stored Google token has an unknown format.");
  const p = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(c));
  return new TextDecoder().decode(p);
}
