// The single place the client-mode → storage-scope matrix is encoded (doc 19,
// client-topology). A Scope is one place this client can ACT ON storage. Every
// feature consumes the ORDERED Scope[] (index 0 = the default) and never re-
// derives the mode axes itself — so a new feature structurally can't forget a
// topology cell the way scattered isNoOrigin()/replicaActive() branches did.
//
// The matrix lives ONLY in scopesFor(): a closed internal `Cell` union switched
// with a `never` exhaustiveness guard, covered by scopes.test.ts. Buckets are a
// backend of the data home, not a byte-management scope, so they are NOT emitted
// here — callers that target buckets (share) layer them on themselves.

import type { ClientMode, Surface } from "./replica.ts";

export type ScopeKind = "local" | "server" | "bucket";

/** How a feature actually performs an op against a scope. Used by blob-manager
 *  (which source to list/clear) and share (transport/target); the storage panel
 *  only needs `kind`. */
export type RouteOp = { via: "http" } | { via: "replica" } | { via: "bucket"; url: string };

export interface Scope {
  /** Stable id: "local" | "server" | `bucket:${url}`. */
  id: string;
  kind: ScopeKind;
  /** Product copy (Notion-style). Never an engineering term — see COPY. */
  label: string;
  /** Secondary line shown under the selector. */
  subtitle: string;
  /** icons.tsx name. */
  icon: string;
  /** Exactly one true across the set; always === scopes[0]. */
  isDefault: boolean;
  routeOp: RouteOp;
  /** Delete UX for this scope's bytes: purge = remove for good (server ledger);
   *  evict = drop the local copy, re-fetched on demand. */
  deleteSemantics: "purge" | "evict";
}

// ---- product copy ----------------------------------------------------------
// User-facing strings only. Reject-list (must never appear here): window,
// replica, dataHome, hold, OPFS, origin, no-origin, S3, peer, publisher,
// snapshot, oplog. Guarded by scopes.test.ts.
const COPY = {
  localDevice: { label: "本机", subtitle: "这台设备上的副本", icon: "monitor" },
  cloudWorkspace: { label: "云端工作区", subtitle: "你常用的在线工作区", icon: "globe" },
  localWorkspace: { label: "本机工作区", subtitle: "这台电脑上的工作区", icon: "monitor" },
} as const;

function localScope(): Scope {
  return {
    id: "local",
    kind: "local",
    label: COPY.localDevice.label,
    subtitle: COPY.localDevice.subtitle,
    icon: COPY.localDevice.icon,
    isDefault: false,
    routeOp: { via: "replica" },
    deleteSemantics: "evict",
  };
}

function serverScope(surface: Surface): Scope {
  // The desktop sidecar's data home is local to the machine, so it reads as a
  // "本机工作区" rather than a remote cloud workspace — a pure copy switch.
  const c = surface === "desktop" ? COPY.localWorkspace : COPY.cloudWorkspace;
  return {
    id: "server",
    kind: "server",
    label: c.label,
    subtitle: c.subtitle,
    icon: c.icon,
    isDefault: false,
    routeOp: { via: "http" },
    deleteSemantics: "purge",
  };
}

/** The named topology cells. Internal to this module — the whole point is that
 *  features never see cells, only the resolved Scope[]. */
type Cell = "thin" | "offline-replica" | "bucket-replica" | "sidecar" | "cli";

function cellOf(mode: ClientMode): Cell {
  if (mode.surface === "cli") return "cli";
  if (mode.surface === "desktop") return "sidecar";
  if (mode.dataHome === "local") return "bucket-replica"; // no-origin ⇒ always replica
  return mode.hold === "replica" ? "offline-replica" : "thin";
}

/**
 * The mode → ordered storage-scope set; scopes[0] is the default.
 *
 *  - thin (window+server): [云端工作区]            — online only, nothing on-device
 *  - offline-replica (replica+server): [本机, 云端工作区] — defaults to on-device bytes
 *  - bucket-replica (no-origin): [本机]            — this device IS the data home
 *  - sidecar (desktop): [本机工作区]               — renderer is a pure window, no double-store
 *  - cli: [本机工作区]                             — reserved; never rendered
 */
export function scopesFor(mode: ClientMode): Scope[] {
  const cell = cellOf(mode);
  let out: Scope[];
  switch (cell) {
    case "thin":
      out = [serverScope(mode.surface)];
      break;
    case "offline-replica":
      out = [localScope(), serverScope(mode.surface)];
      break;
    case "bucket-replica":
      out = [localScope()];
      break;
    case "sidecar":
      out = [serverScope(mode.surface)];
      break;
    case "cli":
      out = [serverScope(mode.surface)];
      break;
    default: {
      const _exhaustive: never = cell;
      throw new Error(`scopesFor: unhandled cell ${_exhaustive as string}`);
    }
  }
  // Default = first; recompute isDefault so the invariant can't drift.
  return out.map((s, i) => ({ ...s, isDefault: i === 0 }));
}
