// Single sign-on for *.thejonbroadbent.com.
//
// auth.thejonbroadbent.com signs you in with Google and sets one cookie, `jb_sso`, on the parent
// domain, so every subdomain receives it. Apps copy this file and call `ssoUser(request, env.SSO_SECRET)`.
// Scripts send the same kind of token as `Authorization: Bearer v1.…` (mint one with JB_SSO's `npm run token`).
//
// Token format: v1.<base64url(JSON {e: email, x: expiry (unix s), i: issued (unix s)})>.<base64url(HMAC-SHA256)>
// Rotating SSO_SECRET (on auth and every app) signs everyone out everywhere.

export const SSO_COOKIE = "jb_sso";
export const SSO_ORIGIN = "https://auth.thejonbroadbent.com";
export const ssoLoginUrl = (next) => `${SSO_ORIGIN}/login?next=${encodeURIComponent(next)}`;
export const ssoLogoutUrl = `${SSO_ORIGIN}/logout`;

const enc = new TextEncoder();
const toB64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const keys = new Map();
function hmacKey(secret) {
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  return keys.get(secret);
}

export async function ssoSign(payload, secret) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode("v1." + body));
  return `v1.${body}.${toB64u(sig)}`;
}

export async function ssoVerify(token, secret) {
  if (!token || !secret) return null;
  const [v, body, sig] = String(token).split(".");
  if (v !== "v1" || !body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64u(sig), enc.encode("v1." + body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (typeof p.e !== "string" || !(p.x * 1000 > Date.now())) return null;
    return { email: p.e, machine: p.e.startsWith("machine:"), expires: p.x };
  } catch {
    return null;
  }
}

// The signed-in user for this request ({ email, machine, expires }), or null.
export function ssoUser(request, secret) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer v1.")) return ssoVerify(auth.slice(7).trim(), secret);
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)jb_sso=([^;]+)/);
  return ssoVerify(m && m[1], secret);
}

// Use before proxying a request to anything outside your own Worker, so the session never leaves Cloudflare.
export function stripSso(headers) {
  const h = new Headers(headers);
  const c = h.get("cookie");
  if (c) {
    const rest = c.split(/;\s*/).filter((p) => !p.startsWith("jb_sso=")).join("; ");
    rest ? h.set("cookie", rest) : h.delete("cookie");
  }
  if ((h.get("authorization") || "").startsWith("Bearer v1.")) h.delete("authorization");
  return h;
}
