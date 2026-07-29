// Share targeting expressed in the unified Scope vocabulary (scopes.ts). Share
// is a per-feature layering: its target set is NOT scopesFor(mode) — it wants
// MANY server targets (current origin + paired peers) PLUS attached buckets, so
// it builds its own Scope[] here. The matrix in scopesFor() deliberately omits
// buckets; this is the sanctioned place that layers them on for share.
//
// Pure + dependency-free (type-only imports) so it unit-tests without preact/api.

import type { Scope } from "./scopes.ts";
import type { ShareTargetOpt } from "../api.ts";

/** Build the ordered share target list: current server (default, index 0) +
 *  paired peer servers + attached buckets. The peer/bucket url is encoded in the
 *  scope id (server:${url} / bucket:${url}) so shareTargetUrl() can recover it —
 *  this is the fix for the peer-server share bug (a server routeOp carries no
 *  url, so without the id the create() body would always target the origin). */
export function buildShareTargets(
  servers: ShareTargetOpt[],
  buckets: ShareTargetOpt[],
  origin: string,
): Scope[] {
  const out: Scope[] = [
    {
      id: "server",
      kind: "server",
      label: "当前服务器",
      subtitle: origin,
      icon: "globe",
      isDefault: true,
      routeOp: { via: "http" },
      deleteSemantics: "purge",
    },
  ];
  for (const s of servers)
    out.push({
      id: `server:${s.url}`,
      kind: "server",
      label: s.label,
      subtitle: s.url,
      icon: "globe",
      isDefault: false,
      routeOp: { via: "http" },
      deleteSemantics: "purge",
      availability: {
        enabled: s.enabled !== false,
        lastStatus: s.lastStatus ?? null,
        lastSuccessAt: s.lastSuccessAt ?? null,
      },
    });
  for (const b of buckets)
    out.push({
      id: `bucket:${b.url}`,
      kind: "bucket",
      label: "存储桶",
      subtitle: b.label,
      icon: "database",
      isDefault: false,
      routeOp: { via: "bucket", url: b.url },
      deleteSemantics: "evict",
    });
  return out;
}

/** Recover the target url create() needs: buckets carry it in routeOp; peer
 *  servers encode it in the id (server:${url}); the current server is the origin. */
export function shareTargetUrl(s: Scope, origin: string): string {
  if (s.routeOp.via === "bucket") return s.routeOp.url;
  if (s.id.startsWith("server:")) return s.id.slice("server:".length);
  return origin;
}
