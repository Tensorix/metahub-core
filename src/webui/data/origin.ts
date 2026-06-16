// Shared origin-mode classification for the browser shell AND the service
// worker. The same bundle runs two ways: served by a metahub server (origin
// mode — pair + HTTP fallback) or from a data-blind static CDN (no-origin mode —
// the bucket is the only data source). We auto-detect off /health so nothing
// hardcodes a domain.
//
// The classifier is deliberately THREE-state. Folding a transient 5xx (server
// up but mid-deploy) into the same "none" verdict as a real 404 once bricked
// first-visit users: a single deploy-window 502 got cached as "none" and locked
// them onto the enroll screen permanently, with no self-heal. Only a definitive
// verdict ("server"/"none") is cacheable; "unknown" must never stick.

export type OriginMode = "server" | "none";

/**
 * Classify a /health probe into a cacheable verdict or "unknown".
 *  - "server":  a 2xx response whose parsed body is `{ok:true}`.
 *  - "none":    a static host — a 4xx (<500, no /health route) OR a 2xx whose
 *               body isn't the health JSON (SPA fallback served index.html).
 *  - "unknown": inconclusive — the fetch threw (`res === null`: offline /
 *               network / DNS) or the server is present but erroring (>=500,
 *               e.g. a 502/503 during a deploy). Callers MUST NOT cache this.
 */
export function classifyOrigin(
  res: Response | null,
  body: { ok?: boolean } | null,
): OriginMode | "unknown" {
  if (res === null) return "unknown"; // fetch threw — offline / network error
  if (res.status >= 500) return "unknown"; // server up but erroring (502/503/…)
  if (res.ok) return body?.ok === true ? "server" : "none"; // health JSON vs SPA fallback
  return "none"; // 4xx (<500): no /health route → a static host
}

/**
 * Probe /health once and classify. Network/parse failures and 5xx collapse to
 * "unknown"; the caller decides how to treat it (assume server, don't cache).
 */
export async function probeOrigin(): Promise<OriginMode | "unknown"> {
  let res: Response | null = null;
  let body: { ok?: boolean } | null = null;
  try {
    res = await fetch("/health", { cache: "no-store" });
    body = res.ok ? ((await res.json().catch(() => null)) as { ok?: boolean } | null) : null;
  } catch {
    res = null; // network error / offline → inconclusive
  }
  return classifyOrigin(res, body);
}
