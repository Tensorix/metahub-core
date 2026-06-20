import { defineCommand } from "citty";
import type { Database } from "bun:sqlite";
import { openMetahub } from "../../core/db.ts";
import { idKind } from "../../core/ids.ts";
import { MhError } from "../../core/errors.ts";
import { getShare, type ShareKind, type SharePermission } from "../../core/shares.ts";
import { getPeer } from "../../core/sync/peers.ts";
import {
  createShareAction,
  revokeShareAction,
  renewShareAction,
  listSharesAggregated,
  listShareServers,
  listShareBuckets,
} from "../../core/sync/share-actions.ts";
import { getServerConfig } from "../../core/config.ts";
import { parseDuration } from "../../core/sync/token.ts";
import { print, table, guard } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

function inferKind(ref: string, explicit?: string): ShareKind {
  if (explicit) {
    if (explicit === "doc" || explicit === "database" || explicit === "site") return explicit;
    throw new MhError("invalid_input", `--kind must be doc | database | site`);
  }
  const k = idKind(ref);
  if (k === "doc") return "doc";
  if (k === "db") return "database";
  if (k === "site") return "site";
  throw new MhError("invalid_input", "could not infer kind from the ref — pass --kind doc|database|site");
}

/** This node's own reachable base for a local server share's link. */
function localServerBase(db: Database): string {
  const cfg = getServerConfig(db);
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}

const create = defineCommand({
  meta: { name: "create", description: "Create a share link for a doc / database / site" },
  args: {
    target: { type: "positional", required: true, description: "Target ref (id/name)" },
    kind: { type: "string", description: "doc | database | site (inferred from a typed id if omitted)" },
    transport: { type: "string", description: "server | s3 (default server)" },
    permission: { type: "string", description: "view | edit (default view; edit is server-only)" },
    password: { type: "string", description: "Protect the share with a password" },
    expires: { type: "string", description: "Expiry, e.g. 24h / 7d (server: any; s3: capped at 7d)" },
    via: { type: "string", description: "Server target: a paired peer url → create there; else a reachable base url for the link (avoids the root --server flag)" },
    bucket: { type: "string", description: "Object-storage bucket peer url (s3; default the only one)" },
    viewer: { type: "string", description: "Static viewer base URL (s3)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const kind = inferKind(args.target, args.kind);
    const transport = (args.transport as "server" | "s3" | undefined) ?? "server";
    if (transport !== "server" && transport !== "s3")
      throw new MhError("invalid_input", "--transport must be server | s3");
    const permission = (args.permission as SharePermission | undefined) ?? "view";
    const expiresMs = args.expires ? parseDuration(args.expires, 0) : 0;
    const server = transport === "server" ? (args.via ?? localServerBase(db)) : undefined;

    const out = await createShareAction(db, {
      kind,
      ref: args.target,
      transport,
      permission,
      password: args.password ?? null,
      expiresMs: expiresMs > 0 ? expiresMs : null,
      server,
      bucketUrl: args.bucket ?? null,
      viewerBase: args.viewer,
    });

    print(out, () =>
      `${out.url}\n通过：${out.source}\n` +
      (out.transport === "server"
        ? "提示：host 需别人可达（LAN IP / 域名 / 隧道）才能给别人访问。"
        : "提示：预签名链接最长 7 天；过期用 `mh share renew` 续期。"),
    );
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List shares (this node + paired servers + buckets)" },
  args: {
    target: { type: "string", description: "Filter to one target id" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = await listSharesAggregated(db, args.target);
    print(rows, () =>
      table(
        rows.map((r) => ({
          slug: r.slug,
          kind: r.kind,
          perm: r.permission,
          via: r.source,
          pw: r.hasPassword ? "🔒" : "",
          expires: r.expiresAt ? new Date(r.expiresAt).toISOString() : "never",
        })),
      ),
    );
  }),
});

const servers = defineCommand({
  meta: { name: "servers", description: "List share targets: this node's servers + buckets" },
  args: { ...FRESH_ARGS },
  run: guard((args) => {
    const db = openMetahub();
    const rows = [
      ...listShareServers(db).map((s) => ({ type: "server", target: s.url, label: s.label })),
      ...listShareBuckets(db).map((b) => ({ type: "bucket", target: b.url, label: b.label })),
    ];
    print(rows, () => table(rows));
  }),
});

const revoke = defineCommand({
  meta: { name: "revoke", description: "Revoke a share (server row / bucket objects; --via to revoke on a peer)" },
  args: {
    slug: { type: "positional", required: true, description: "Share slug" },
    via: { type: "string", description: "Revoke on this paired peer (proxy DELETE)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    if (args.via) {
      const peer = getPeer(db, args.via);
      const res = await fetch(`${args.via.replace(/\/+$/, "")}/api/share?slug=${encodeURIComponent(args.slug)}`, {
        method: "DELETE",
        headers: peer?.token ? { authorization: `Bearer ${peer.token}` } : {},
      });
      print({ ok: res.ok, revoked: res.ok ? args.slug : null });
      return;
    }
    const ok = await revokeShareAction(db, args.slug);
    print({ ok, revoked: ok ? args.slug : null });
  }),
});

const renew = defineCommand({
  meta: { name: "renew", description: "Re-presign an object-storage share and print a fresh link" },
  args: { slug: { type: "positional", required: true, description: "Share slug" } },
  run: guard(async (args) => {
    const db = openMetahub();
    const out = await renewShareAction(db, args.slug);
    print(out, () => `${out.url}\n通过：${out.source}`);
  }),
});

const link = defineCommand({
  meta: { name: "link", description: "Re-copy a share's link (server: rebuild; s3: re-presign)" },
  args: { slug: { type: "positional", required: true, description: "Share slug" } },
  run: guard(async (args) => {
    const db = openMetahub();
    const local = getShare(db, args.slug);
    if (local) {
      const url = `${local.served_base ?? localServerBase(db)}/share/${local.slug}`;
      print({ url }, () => url);
      return;
    }
    const out = await renewShareAction(db, args.slug);
    print(out, () => out.url);
  }),
});

export default defineCommand({
  meta: { name: "share", description: "Create and manage public share links" },
  subCommands: { create, list, servers, revoke, rm: revoke, renew, link },
});
