// Shared guest-write anti-abuse gate: Turnstile siteverify + password-verifier
// check. BOTH guest-write transports of a site grant enforce THIS one gate — the
// edge worker's write-inbox (envelope submission) and the server's realtime
// granted API (sites-serve.ts) — so `mh site grant --password/--turnstile` can
// never be honored on one transport and silently skipped on the other.
//
// Portable by construction (Request / fetch / WebCrypto only, no node:/bun:), so
// the workerd edge and the node server import the SAME implementation.

import { MhError } from "../errors.ts";

/** Constant-time string equality (length leaks, content never). Shared by the
 *  edge owner-token check and the password-verifier compare. */
export function timingSafeEq(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export type VerifyTurnstile = (secret: string, token: string, ip: string | null) => Promise<boolean>;

/** Cloudflare Turnstile siteverify. Fails closed on any network/parse error —
 *  including the 5s timeout: this runs on the guest-write request path, so a
 *  hung siteverify endpoint must 401 fast, not pile up handlers/sockets. */
export const siteverify: VerifyTurnstile = async (secret, token, ip) => {
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data?.success === true;
  } catch {
    return false;
  }
};

/** The per-grant anti-abuse secrets (a subset of edge-config's DropKnobs and the
 *  edge D1 `drops` row — structurally compatible with both). */
export interface AntiAbuseKnobs {
  turnstileSecret?: string | null;
  passwordVerifier?: string | null;
}

/**
 * Throw MhError("auth") if the request fails the grant's configured anti-abuse
 * knobs; no knobs → no-op (open submission). Reads the same headers the drop SDK
 * sends: `x-turnstile-token` (verified via siteverify) and `x-drop-pass` (the
 * PBKDF2 verifier the page derived from (password, published salt), compared
 * constant-time — the password itself never travels).
 */
export async function assertAntiAbuse(
  knobs: AntiAbuseKnobs | null | undefined,
  req: Request,
  opts: { verifyTurnstile?: VerifyTurnstile; ip?: string | null } = {},
): Promise<void> {
  if (!knobs) return;
  if (knobs.turnstileSecret) {
    const verify = opts.verifyTurnstile ?? siteverify;
    const token = req.headers.get("x-turnstile-token") ?? "";
    if (!token || !(await verify(knobs.turnstileSecret, token, opts.ip ?? null)))
      throw new MhError("auth", "turnstile verification failed");
  }
  if (knobs.passwordVerifier) {
    const pass = req.headers.get("x-drop-pass") ?? "";
    if (!pass || !timingSafeEq(pass, knobs.passwordVerifier))
      throw new MhError("auth", "password required");
  }
}
