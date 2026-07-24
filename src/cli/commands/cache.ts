import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  readPolicy,
  setFullNodes,
  setRedundancy,
  knownNodes,
  cacheStats,
  cachedBlobs,
  setPinned,
  clearCache,
  gcOrphans,
  reconcileCache,
  type Redundancy,
  type KnownNode,
} from "../../core/blobs.ts";
import { getServerConfig } from "../../core/config.ts";
import { MhError } from "../../core/errors.ts";
import { print, table, guard } from "../output.ts";
import * as p from "@clack/prompts";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const isTTY = () => process.stdout.isTTY && process.stdin.isTTY;

function nodeLabel(n: KnownNode): string {
  const base = n.label ? `${n.label} (${n.nodeId})` : n.nodeId;
  return n.self ? `${base} · this device` : base;
}

type Db = ReturnType<typeof openMetahub>;

function showStatus(db: Db): void {
  reconcileCache(db);
  const stats = cacheStats(db);
  const { fullNodes, redundancy } = readPolicy(db);
  const quota = getServerConfig(db).blobCacheQuotaBytes;
  const pinned = cachedBlobs(db).filter((b) => b.pinned);
  const pinnedBytes = pinned.reduce((s, b) => s + b.size, 0);
  const known = knownNodes(db);
  const fullView = fullNodes.map((id) => {
    const n = known.find((k) => k.nodeId === id);
    return n ? nodeLabel(n) : id;
  });
  print({ stats, policy: { fullNodes, redundancy }, quotaBytes: quota, pinnedCount: pinned.length }, () =>
    [
      `cache: ${stats.count} blob(s), ${fmtBytes(stats.totalBytes)}`,
      `  clearable: ${stats.clearableCount} blob(s) · ${fmtBytes(stats.clearableBytes)}`,
      `  retained:  ${fmtBytes(stats.retainedBytes)}`,
      `  pinned:    ${pinned.length} blob(s) · ${fmtBytes(pinnedBytes)}`,
      `quota: ${quota > 0 ? `${fmtBytes(quota)} (auto-evicts over this)` : "disabled"}`,
      ``,
      `full blob device(s): ${
        fullView.length ? fullView.join(", ") : "(none — nothing is clearable until you set one)"
      }`,
      `redundancy: ${redundancy} (clearable when ${
        redundancy === "all" ? "every" : "any"
      } full device holds it)`,
    ].join("\n"),
  );
}

/** Resolve the target node id for full-device add/rm: explicit --node, else an
 *  interactive pick on a TTY, else an error carrying the usage line. */
async function pickNode(
  db: Db,
  args: Record<string, any>,
  candidates: KnownNode[],
  message: string,
  usage: string,
): Promise<string> {
  if (typeof args.node === "string" && args.node) return args.node;
  if (!candidates.length) throw new MhError("not_found", "no candidate devices");
  if (isTTY()) {
    const choice = await p.select({
      message,
      options: candidates.map((n) => ({ value: n.nodeId, label: nodeLabel(n) })),
    });
    if (p.isCancel(choice)) {
      p.cancel("cancelled");
      throw new MhError("invalid_input", "cancelled");
    }
    return choice as string;
  }
  throw new MhError("invalid_input", `missing --node\nusage: ${usage}`);
}

async function fullDeviceDispatch(db: Db, target: string, args: Record<string, any>): Promise<void> {
  const { fullNodes } = readPolicy(db);
  const known = knownNodes(db);
  switch (target) {
    case "list": {
      const rows = known.map((n) => ({
        node: n.nodeId,
        label: n.label ?? "",
        device: n.self ? "this" : "",
        full: fullNodes.includes(n.nodeId) ? "yes" : "",
      }));
      print({ fullNodes, devices: rows }, () => (rows.length ? table(rows) : "(no devices)"));
      return;
    }
    case "add": {
      const candidates = known.filter((n) => !fullNodes.includes(n.nodeId));
      if (!candidates.length) throw new MhError("conflict", "every known device is already a full library");
      const node = await pickNode(
        db,
        args,
        candidates,
        "Designate a full blob device",
        "mh cache full-device add --node <id>",
      );
      setFullNodes(db, [...fullNodes, node]);
      print({ fullNodes: readPolicy(db).fullNodes }, () => `added full blob device ${node}`);
      return;
    }
    case "rm": {
      const candidates = known.filter((n) => fullNodes.includes(n.nodeId));
      if (!fullNodes.length) throw new MhError("not_found", "no full blob devices set");
      const node = await pickNode(
        db,
        args,
        candidates,
        "Remove a full blob device",
        "mh cache full-device rm --node <id>",
      );
      setFullNodes(db, fullNodes.filter((n) => n !== node));
      print({ fullNodes: readPolicy(db).fullNodes }, () => `removed full blob device ${node}`);
      return;
    }
    default:
      throw new MhError("invalid_input", `unknown full-device action '${target}' (list|add|rm)`);
  }
}

/** Workspace blob-anchor policy, shared with `mh config backup anchors`
 *  (list|add|rm|redundancy <all|any>). `mh cache full-device`/`redundancy`
 *  remain the tool-side aliases of the same dispatch. */
export async function anchorsDispatch(
  db: Db,
  sub: string | undefined,
  value: string | undefined,
  args: Record<string, any>,
): Promise<void> {
  if (sub === "redundancy") {
    if (value !== "all" && value !== "any")
      throw new MhError("invalid_input", "usage: mh config backup anchors redundancy <all|any>");
    setRedundancy(db, value as Redundancy);
    print({ redundancy: value }, () => `redundancy set to ${value}`);
    return;
  }
  if (sub && !["list", "add", "rm"].includes(sub))
    throw new MhError(
      "invalid_input",
      `unknown anchors action '${sub}' (list|add|rm|redundancy all|any)`,
    );
  return fullDeviceDispatch(db, sub ?? "list", args);
}

export default defineCommand({
  meta: {
    name: "cache",
    description:
      "Inspect and clear the local blob cache (document images / large files). " +
      "Only blobs durably held by a designated 'full blob device' are clearable — " +
      "the reference stays, the bytes re-download on demand. " +
      "Actions: status (default) | clear | gc | full-device list|add|rm | redundancy all|any | " +
      "pin <hash> | unpin <hash>.",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "status | clear | gc | full-device | redundancy | pin | unpin (default status)",
    },
    target: {
      type: "positional",
      required: false,
      description: "full-device: list|add|rm · redundancy: all|any · pin/unpin: <hash>",
    },
    node: { type: "string", description: "Device node id (full-device add/rm)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const action = (typeof args.action === "string" ? args.action : "status") || "status";
    const target = typeof args.target === "string" ? args.target : undefined;

    switch (action) {
      case "status":
        return showStatus(db);
      case "clear": {
        const r = await clearCache(db);
        print(r, () =>
          r.cleared
            ? `cleared ${r.cleared} blob(s), freed ${fmtBytes(r.freedBytes)}` +
              (r.skipped ? ` (kept ${r.skipped} not yet safe to clear)` : "")
            : readPolicy(db).fullNodes.length
              ? `nothing cleared (kept ${r.skipped} not yet safe to clear)`
              : "nothing cleared — set a full blob device first: mh cache full-device add",
        );
        return;
      }
      case "gc": {
        const r = await gcOrphans(db);
        print(r, () =>
          r.removed ? `removed ${r.removed} orphan blob(s), freed ${fmtBytes(r.freedBytes)}` : "no orphan blobs",
        );
        return;
      }
      case "full-device":
        return fullDeviceDispatch(db, target ?? "list", args);
      case "redundancy": {
        if (target !== "all" && target !== "any")
          throw new MhError("invalid_input", "usage: mh cache redundancy <all|any>");
        setRedundancy(db, target as Redundancy);
        print({ redundancy: target }, () => `redundancy set to ${target}`);
        return;
      }
      case "pin":
      case "unpin": {
        if (!target) throw new MhError("invalid_input", `usage: mh cache ${action} <hash>`);
        reconcileCache(db); // fold disk-only blobs into the ledger so a fresh hash can be pinned
        const ok = setPinned(db, target, action === "pin");
        if (!ok) throw new MhError("not_found", `blob not in cache: ${target}`);
        print({ hash: target, pinned: action === "pin" }, () =>
          action === "pin" ? `pinned ${target} (kept on clear / eviction)` : `unpinned ${target}`,
        );
        return;
      }
      default:
        throw new MhError(
          "invalid_input",
          `unknown cache action '${action}' (status|clear|gc|full-device|redundancy|pin|unpin)`,
        );
    }
  }),
});
