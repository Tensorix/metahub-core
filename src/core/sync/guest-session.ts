// Guest session cookies for capability-scoped surfaces — extracted from
// share-serve.ts so the exact same mint/verify logic runs on this node's
// /share/<slug> endpoints AND inside the Durable Object room (/r/<slug>).
// PORTABLE: WebCrypto only, no node:/bun: imports.
//
// Cookie value: `<exp>.<sub>.<mac>` where `sub` is the per-visitor guest sub id
// minted at session start (final decision 2: one guest identity PER VISITOR).
// The MAC binds (scopeKey, exp, sub) under a host-local secret, so a cookie
// can neither be forged nor replayed across shares/rooms.

export interface GuestSessionScope {
  /** HMAC secret (host-local, e.g. meta.share_cookie_secret / room cookie secret). */
  secret: string;
  /** Cookie name, e.g. `mh_share_<slug>` / `mh_room_<slug>`. */
  cookieName: string;
  /** MAC scope discriminator — the slug. */
  scopeKey: string;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg) as unknown as ArrayBuffer);
  return toHex(new Uint8Array(sig));
}

export function timingSafeStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Verified session payload from the cookie header, or null when absent/
 *  expired/forged. `sub` is "" for read-only sessions (no author identity). */
export async function readGuestSession(
  scope: GuestSessionScope,
  cookieHeader: string | null,
  now = Date.now(),
): Promise<{ exp: number; sub: string } | null> {
  const raw = readCookie(cookieHeader, scope.cookieName);
  if (!raw) return null;
  const [expStr, sub, mac] = raw.split(".");
  if (expStr === undefined || sub === undefined || mac === undefined) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || now > exp) return null;
  const expect = await hmacHex(scope.secret, `${scope.scopeKey}:${exp}:${sub}`);
  return timingSafeStr(expect, mac) ? { exp, sub } : null;
}

/** Mint a fresh session cookie for `sub`, valid for `ttlMs`, scoped to `path`. */
export async function mintGuestSession(
  scope: GuestSessionScope,
  opts: { sub: string; ttlMs: number; path: string; secure: boolean },
): Promise<{ sub: string; exp: number; cookie: string }> {
  const exp = Date.now() + Math.max(0, opts.ttlMs);
  const mac = await hmacHex(scope.secret, `${scope.scopeKey}:${exp}:${opts.sub}`);
  const cookie =
    `${scope.cookieName}=${exp}.${opts.sub}.${mac}; Path=${opts.path}; SameSite=Strict; Max-Age=${Math.floor(
      (exp - Date.now()) / 1000,
    )}` + (opts.secure ? "; Secure" : "");
  return { sub: opts.sub, exp, cookie };
}
