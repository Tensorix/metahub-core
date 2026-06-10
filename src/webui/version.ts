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
