// Build version of the WebUI shell, stamped into /webui.js by the server when
// serving it (see server/assets.ts getJsStamped — the same trick as the service
// worker's __MH_SW_VERSION__). The data-blind PWA shell has no /api/version
// server to ask, so this baked constant is the only version it knows.
const STAMP = "__MH_WEBUI_VERSION__";

/** The stamped WebUI build version (e.g. "0.2.0"), or null when unstamped
 *  (defensive: the placeholder still present means it was served without the
 *  stamp pass). The replaceAll target is the full token, so the `"__MH_"` guard
 *  literal below is never touched. */
export const WEBUI_VERSION: string | null = STAMP.startsWith("__MH_") ? null : STAMP;

/** Numeric semver-ish compare: >0 if a>b, <0 if a<b, 0 if equal. Tolerates a
 *  `v` prefix. Used by the settings footer's update flow and the app's
 *  "update staged" check. */
export function cmpVer(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
