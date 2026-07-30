import { join } from "node:path";
import { defineCommand } from "citty";
// Build-time text embed (same mechanism as SKILL.md in agent-skill.ts). The
// .txt suffix keeps both Bun's HTML loader (which would try to bundle the
// template's references) and bun-types' `*.html` HTMLBundle declaration out of
// the way — plain text in, plain text out (the spike's sanctioned fallback:
// tsc can't be made to prefer a longer-suffix ambient over `*.html`, both
// wildcard patterns tie on prefix length).
import STARTER_HTML from "../site-starter.html.txt" with { type: "text" };
import type { DbDriver } from "../../core/driver.ts";
import { openMetahub } from "../../core/db.ts";
import {
  createSite,
  getSiteByName,
  listSites,
  resolveSite,
  setSitePublicGrants,
  putFile,
  publishDirectory,
  listFiles,
  deleteFile,
  type SiteRow,
} from "../../core/sites.ts";
import {
  parseGrantSet,
  parseGrantSpec,
  type GrantSet,
} from "../../core/grants-core.ts";
import { getEdgeConfig, getDropKnobs, setDropKnobs } from "../../core/sync/edge-config.ts";
import { siteReachability } from "../../core/sync/site-reachability.ts";
import { syncDropWiring, siteHasCreateGrant, type DropWireResult } from "../../core/sync/drop-wire.ts";
import { deriveShareKey, toB64 } from "../../core/sync/e2ee.ts";
import { getDatabase } from "../../core/databases.ts";
import { resolveEntity } from "../../core/resolve.ts";
import { resolveValue } from "../input.ts";
import { errorCode, MhError } from "../../core/errors.ts";
import { print, table, guard, warn } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";
import { localServerBase } from "../local-base.ts";
import { getServerConfig } from "../../core/config.ts";
import { getNodeId } from "../../core/node.ts";
import {
  applySiteDelete,
  applySiteUpdate,
  sitePublicAccessState,
  putSiteChannel,
  putSiteChannelObservation,
  setPublicSiteChannelPolicies,
} from "../../core/site-channel-store.ts";
import { reconcileSiteChannelsQuietly } from "../../core/sync/site-channel-reconcile.ts";

/** The URL a site is served at by this node's server. */
function siteUrl(db: DbDriver, name: string): string {
  const base = getServerConfig(db).publicBaseUrl ?? localServerBase(db);
  return `${base}/sites/${encodeURIComponent(name)}/`;
}

/** CLI visibility is a local-device publish action. Record that topology
 * explicitly so another synced node cannot accidentally inherit public serve
 * authority from the legacy visibility register. */
function recordCliPublicChannel(db: DbDriver, site: SiteRow): void {
  const channel = putSiteChannel(db, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    targetRef: getNodeId(db),
    canonicalUrl: siteUrl(db, site.name),
    policy: parseGrantSet(site.public_grants),
  });
  putSiteChannelObservation(db, {
    channelId: channel.id,
    status: "legacy_unverified",
  });
}

const create = defineCommand({
  meta: { name: "create", description: "Create a static site (bucket)" },
  args: {
    name: { type: "positional", required: true, description: "Site name (URL slug)" },
    title: { type: "string", description: "Human-readable title" },
    public: {
      type: "boolean",
      description: "Serve without a token (anyone can read; page /api calls stay unauthorized)",
    },
  },
  run: guard((args) => {
    const db = openMetahub();
    const site = createSite(db, {
      name: args.name,
      title: args.title,
      // Explicit channel below is the authority; the legacy synced register
      // stays private so older peers cannot expose the site by accident.
      visibility: "private",
    });
    if (args.public) recordCliPublicChannel(db, site);
    const url = siteUrl(db, site.name);
    const visibility = args.public ? "public" : "private";
    print(
      { id: site.id, name: site.name, visibility, url },
      () =>
        `${site.id}\t${site.name}${visibility === "public" ? "\t(public)" : ""}\n` +
        `next: mh site upload ${site.name} <dir>`,
    );
  }),
});

const update = defineCommand({
  meta: {
    name: "update",
    description: "Change a site's visibility (--visibility public|private), SPA mode (--spa/--no-spa) or title",
  },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    visibility: { type: "string", description: "public (token-free reads) or private" },
    spa: {
      type: "boolean",
      description: "SPA fallback: extension-less misses serve index.html (--no-spa to disable)",
    },
    title: { type: "string", description: "Human-readable title" },
  },
  run: guard((args) => {
    if (args.visibility === undefined && args.spa === undefined && args.title === undefined)
      throw new MhError(
        "invalid_input",
        "nothing to update — pass --visibility public|private, --spa/--no-spa and/or --title",
      );
    if (args.visibility !== undefined)
      warn("--visibility is deprecated; use `mh site access <site> public|private`");
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    // Core validates the enum (invalid values → MhError invalid_input); the
    // update and its channel side effects commit or roll back together.
    const updated = applySiteUpdate(
      db,
      site.id,
      {
        visibility: args.visibility as "public" | "private" | undefined,
        spa: args.spa,
        title: args.title,
      },
      { recordPublic: (s) => recordCliPublicChannel(db, s) },
    );
    const visibility = sitePublicAccessState(db, updated).configured
      ? "public"
      : "private";
    const url = siteUrl(db, updated.name);
    print(
      { id: updated.id, name: updated.name, visibility, spa: updated.spa === 1, title: updated.title, url },
      () =>
        `${updated.id}\t${updated.name}\n` +
        `visibility: ${visibility}\tspa: ${updated.spa === 1 ? "on" : "off"}\n` +
        (visibility === "public"
          ? `public url: ${url} (anyone can read; page /api calls stay unauthorized)`
          : `url: ${url} (token required)`),
    );
  }),
});

/** Write the starter page into `dir` (created if missing). A pre-existing
 *  index.html is a loud conflict unless forced — scaffold must never silently
 *  clobber a page someone already built. Exported for tests. */
export async function scaffoldSiteDir(
  dir: string,
  opts: { force?: boolean } = {},
): Promise<{ dir: string; created: string[]; next: string }> {
  const target = join(dir, "index.html");
  if (!opts.force && (await Bun.file(target).exists()))
    throw new MhError("conflict", `${target} already exists — pass --force to overwrite`);
  await Bun.write(target, STARTER_HTML); // creates the directory chain
  return { dir, created: ["index.html"], next: `mh site upload <name> ${dir} --create` };
}

const scaffold = defineCommand({
  meta: {
    name: "scaffold",
    description: "Write a starter index.html (SDK import + working data example) into a directory",
  },
  args: {
    dir: { type: "positional", required: true, description: "Target directory (created if missing)" },
    force: { type: "boolean", description: "Overwrite an existing index.html" },
  },
  run: guard(async (args) => {
    const res = await scaffoldSiteDir(args.dir, { force: Boolean(args.force) });
    print(res, () => `created ${join(res.dir, "index.html")}\nnext: ${res.next}`);
  }),
});

const put = defineCommand({
  meta: { name: "put", description: "Upload or replace one file in a site" },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    path: { type: "positional", required: true, description: "File path within the site, e.g. index.html" },
    from: { type: "string", description: "Read bytes from a local file" },
    content: { type: "string", description: "Inline text content (@file/@- ok)" },
    type: { type: "string", description: "Content-Type (else inferred from path)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    let data: string | Uint8Array;
    if (args.from != null) {
      data = new Uint8Array(await Bun.file(args.from).arrayBuffer());
    } else if (args.content != null) {
      data = (await resolveValue(args.content)) ?? "";
    } else {
      throw new Error("provide --from <file> or --content <text|@file|@->");
    }
    const f = await putFile(db, site.id, args.path, { data, contentType: args.type });
    print(
      { id: f.id, path: f.path, content_type: f.content_type, encoding: f.encoding },
      () => `${f.path}\t${f.content_type}\t${f.encoding}`,
    );
  }),
});

const upload = defineCommand({
  meta: {
    name: "upload",
    description:
      "Upload every file in a directory to a site (--create to create a missing site; --prune mirrors deletes)",
  },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    dir: { type: "positional", required: true, description: "Local directory to publish" },
    create: { type: "boolean", description: "Create the site if it doesn't exist" },
    prune: {
      type: "boolean",
      description: "Delete remote files that no longer exist locally (mirror)",
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const site = resolveSiteForPublish(db, args.site, Boolean(args.create));
    const res = await publishDirectory(db, site.id, args.dir, { prune: Boolean(args.prune) });
    const unchanged = new Set(res.unchanged);
    const all = [...res.uploaded, ...res.unchanged].sort();
    const url = siteUrl(db, site.name);
    // Grant↔inbox auto-wiring: a create-granted site republishes mh-drop.json
    // (and re-registers) after every publish, so the wiring survives mirrors.
    const wire = await wireDrop(db, site.id);
    print(
      {
        site: site.id,
        name: site.name,
        url,
        // files/paths stay the full local-file view for backwards compatibility;
        // uploaded/unchanged/pruned carry the effect evidence.
        files: all.length,
        paths: all,
        uploaded: res.uploaded,
        unchanged: res.unchanged,
        pruned: res.pruned,
        api: { rest: "/api/*", sdk: "/metahub-sdk.js", docs: "/docs.json" },
        ...(wire?.wired ? { drop: { file: wire.file, registered: wire.registered } } : {}),
      },
      () => {
        let out =
          `uploaded ${all.length} file(s) to ${site.name} ` +
          `(${res.uploaded.length} uploaded, ${res.unchanged.length} unchanged)\n` +
          all.map((p) => (unchanged.has(p) ? `  ${p} (unchanged)` : `  ${p}`)).join("\n") +
          "\n";
        if (res.pruned.length)
          out +=
            `pruned ${res.pruned.length} remote file(s) not in ${args.dir}:\n` +
            `  ${res.pruned.join("\n  ")}\n`;
        if (wire?.wired)
          out += `drop: mh-drop.json ${wire.file}; inbox registration ${wire.registered ? "ok" : "FAILED"}\n`;
        return (
          out +
          `site: ${url}\n` +
          `data: pages fetch('/api/*') same-origin; typed SDK at /metahub-sdk.js; REST docs at /docs.json\n` +
          `注意：站点页面与管理界面同源运行，站点内脚本可以以你的身份读写整个工作区；只发布你信任的代码。`
        );
      },
    );
  }),
});

/** Run the grant↔inbox auto-wiring for a site (fresh row — grants may have just
 *  changed). Never fatal: the wiring is a convenience layered on the command
 *  that triggered it; an unreachable edge downgrades to a warning. */
async function wireDrop(db: DbDriver, siteId: string): Promise<DropWireResult | null> {
  try {
    const fresh = resolveSite(db, siteId);
    const wire = await syncDropWiring(db, fresh);
    if (wire.registerError) warn(`inbox registration failed — ${wire.registerError}`);
    return wire;
  } catch (e) {
    warn(`drop auto-wiring failed — ${(e as Error).message}`);
    return null;
  }
}

/** Site creation on publish is opt-in (--create): a typo'd site name must fail
 *  loudly, not silently mint a new site and publish into it. */
function resolveSiteForPublish(db: DbDriver, ref: string, create: boolean) {
  if (create && !ref.startsWith("site_") && !getSiteByName(db, ref))
    return createSite(db, { name: ref });
  try {
    return resolveSite(db, ref);
  } catch (e) {
    if (!create && errorCode(e) === "not_found")
      throw new MhError("not_found", `${(e as Error).message} — pass --create to create it`);
    throw e;
  }
}

const list = defineCommand({
  meta: {
    name: "list",
    description:
      "List sites with computed access + reachability state (--show-links to include capability URLs)",
  },
  args: {
    "show-links": {
      type: "boolean",
      description:
        "Include full channel details (capability URLs are SECRETS — they grant access)",
    },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    // Capability URLs are access-granting secrets: the default output carries
    // counts + state only, so `site list` can land in logs, scripts and agent
    // context without leaking them. `--show-links` is the explicit opt-in.
    const rows = listSites(db).map((r) => {
      const reachability = siteReachability(db, r.id);
      const channels = reachability.channels;
      const links = channels.filter(
        (c) => c.audience === "link" && c.desiredState !== "revoked",
      );
      const activeLinks = links.filter((c) => c.status !== "expired").length;
      const pub = reachability.publicAccess;
      return {
        id: r.id,
        name: r.name,
        title: r.title,
        access: pub.configured ? "public" : activeLinks > 0 ? "link" : "private",
        state: reachability.state,
        public_channels: channels.filter(
          (c) => c.audience === "anyone" && c.desiredState !== "revoked",
        ).length,
        private_links: {
          active: activeLinks,
          expired: links.length - activeLinks,
        },
        /** Raw synced register — compatibility info, NOT the user-facing state. */
        legacy_visibility: r.visibility,
        ...(pub.anomaly ? { public_config_anomaly: pub.anomaly } : {}),
        ...(args["show-links"] ? { channels } : {}),
      };
    });
    print(rows, () =>
      table(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.title ?? "",
          access: r.access + (r.public_config_anomaly ? " (公开配置异常)" : ""),
          state: r.state,
          links: `${r.public_channels} public, ${r.private_links.active} link${r.private_links.expired ? ` (+${r.private_links.expired} expired)` : ""}`,
        })),
      ) +
        (args["show-links"]
          ? "\n" +
            rows
              .flatMap((r) =>
                (r.channels ?? []).map(
                  (c) => `${r.name}\t${c.audience}/${c.hosting}\t${c.status}\t${c.url ?? "-"}`,
                ),
              )
              .join("\n")
          : ""),
    );
  }),
});

const files = defineCommand({
  meta: { name: "files", description: "List a site's files" },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const site = resolveSite(db, args.site);
    const rows = listFiles(db, site.id);
    print(
      rows,
      () => table(rows.map((r) => ({ path: r.path, type: r.content_type, encoding: r.encoding }))),
    );
  }),
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete one file from a site" },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    path: { type: "positional", required: true, description: "File path within the site" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    const ok = deleteFile(db, site.id, args.path);
    print({ ok, deleted: ok ? args.path : null });
  }),
});

/** Grants payload for output: tables with db names resolved for humans. */
function grantsOut(db: DbDriver, site: SiteRow) {
  const set = parseGrantSet(site.public_grants);
  return set.tables.map((t) => ({
    db: t.db,
    name: getDatabase(db, t.db)?.name ?? "(deleted)",
    ops: t.ops,
  }));
}

/** Grants only take effect on a public channel — say so instead of silently arming. */
function grantEffectNote(db: DbDriver, site: SiteRow): string | null {
  return sitePublicAccessState(db, site).configured
    ? null
    : `grants are stored but NOT in effect — the site is private; run: mh site update ${site.name} --visibility public`;
}

/** Persist the anti-abuse knobs passed on `mh site grant`. The knobs gate BOTH
 *  guest-write transports of the grant (edge inbox + the server's realtime
 *  granted endpoint). The password itself is never stored: only a PBKDF2
 *  salt (published in mh-drop.json) and its verifier (sent to the edge). */
async function applyGrantKnobs(
  db: DbDriver,
  siteId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const has = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (!has(args.turnstile) && !has(args["turnstile-secret"]) && !has(args.password)) return;
  const knobs = getDropKnobs(db, siteId) ?? {};
  if (has(args.turnstile)) knobs.turnstileSitekey = args.turnstile;
  if (has(args["turnstile-secret"])) knobs.turnstileSecret = args["turnstile-secret"];
  if (has(args.password)) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    knobs.passwordSalt = toB64(salt);
    knobs.passwordVerifier = toB64(await deriveShareKey(args.password, salt));
  }
  if (knobs.turnstileSitekey && !knobs.turnstileSecret)
    warn(
      "a Turnstile sitekey without --turnstile-secret cannot be verified at the edge — pass the secret key too",
    );
  setDropKnobs(db, siteId, knobs);
}

/** One honest line about which transport create-grant submissions ride. */
function transportLine(db: DbDriver, site: SiteRow): string | null {
  if (!siteHasCreateGrant(site)) return null;
  const edge = getEdgeConfig(db);
  return edge
    ? `submissions arrive async via edge (~1 min): ${edge.endpoint}`
    : "submissions arrive in real time via this server (it must be reachable; `mh edge deploy` adds an always-on inbox)";
}

const grant = defineCommand({
  meta: {
    name: "grant",
    description:
      "Grant anonymous data access on a public site's /sites/<name>/api/*: <db>:<ops> (ops: read,create,update)",
  },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    spec: {
      type: "positional",
      required: false,
      description: "Grant spec <db>:<ops> (e.g. tasks:read,create); with --revoke just <db>",
    },
    revoke: { type: "boolean", description: "Remove the grant for <db>" },
    clear: { type: "boolean", description: "Remove ALL grants from the site" },
    turnstile: { type: "string", description: "Cloudflare Turnstile sitekey gating anonymous writes" },
    "turnstile-secret": {
      type: "string",
      description: "Turnstile secret key (needed for edge-side verification; never published)",
    },
    password: { type: "string", description: "Submission password (stored as a PBKDF2 verifier, never plaintext)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    const set = parseGrantSet(site.public_grants);

    if (args.clear) {
      if (set.tables.length === 0)
        throw new MhError("not_found", `site ${site.name} has no grants to clear`);
      set.tables = [];
    } else if (args.revoke) {
      if (!args.spec)
        throw new MhError("invalid_input", "pass the database to revoke: mh site grant <site> <db> --revoke");
      const target = resolveEntity(db, args.spec, { kind: "db" });
      const before = set.tables.length;
      set.tables = set.tables.filter((t) => t.db !== target.id);
      if (set.tables.length === before)
        throw new MhError("not_found", `no grant for database ${target.label} on site ${site.name}`);
    } else {
      if (!args.spec)
        throw new MhError(
          "invalid_input",
          "pass a grant spec: mh site grant <site> <db>:read,create (or --revoke <db> / --clear)",
        );
      const { db: ref, ops } = parseGrantSpec(args.spec);
      const target = resolveEntity(db, ref, { kind: "db" });
      // Replace-or-add: one entry per database, the spec is the whole grant.
      const next: GrantSet = {
        v: 1,
        tables: [...set.tables.filter((t) => t.db !== target.id), { db: target.id, ops }],
      };
      set.tables = next.tables;
    }

    const updated = setSitePublicGrants(db, site.id, set.tables.length ? set : null);
    setPublicSiteChannelPolicies(db, updated.id, parseGrantSet(updated.public_grants));
    if (args.clear) setDropKnobs(db, site.id, null);
    else await applyGrantKnobs(db, site.id, args);
    // Auto-wire the write-inbox: create grant + configured edge → publish/update
    // mh-drop.json + register the drop; last create grant gone → tear both down.
    const wire = await wireDrop(db, updated.id);
    const rows = grantsOut(db, updated);
    const effective = sitePublicAccessState(db, updated).configured;
    const note = grantEffectNote(db, updated);
    if (note) warn(note);
    const transport = transportLine(db, updated);
    print(
      {
        site: updated.id,
        name: updated.name,
        grants: rows,
        effective,
        ...(wire ? { transport: wire.transport, drop: { file: wire.file, registered: wire.registered } } : {}),
      },
      () =>
        (rows.length
          ? rows.map((r) => `${r.name} (${r.db}): ${r.ops.join(",")}`).join("\n")
          : "no grants") +
        `\napi: /sites/${updated.name}/api/records?db=<db> (anonymous, ${effective ? "ACTIVE" : "inactive until public"})` +
        (transport ? `\n${transport}` : ""),
    );
  }),
});

const grants = defineCommand({
  meta: { name: "grants", description: "Show a site's public data grants" },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const site = resolveSite(db, args.site);
    const rows = grantsOut(db, site);
    const effective = sitePublicAccessState(db, site).configured;
    const note = rows.length ? grantEffectNote(db, site) : null;
    if (note) warn(note);
    print(
      { site: site.id, name: site.name, grants: rows, effective },
      () =>
        rows.length
          ? table(rows.map((r) => ({ database: r.name, id: r.db, ops: r.ops.join(",") })))
          : "no grants",
    );
  }),
});

const access = defineCommand({
  meta: {
    name: "access",
    description:
      "Show or change who can access a site: `access <site>` shows, `access <site> public|private` changes",
  },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    action: {
      type: "positional",
      required: false,
      description: "public | private (omit to show current access)",
    },
    "show-links": {
      type: "boolean",
      description: "Include full capability URLs (they are SECRETS — they grant access)",
    },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = args.action ? openMetahub() : await freshDb(args);
    const site = resolveSite(db, args.site);

    if (args.action === "public" || args.action === "private") {
      const updated = applySiteUpdate(
        db,
        site.id,
        { visibility: args.action },
        { recordPublic: (s) => recordCliPublicChannel(db, s) },
      );
      // Revocations need the reconciler to run teardown; problems degrade to a
      // warning (the desired state is committed and retries on every sync).
      const reconcileError = await reconcileSiteChannelsQuietly(db);
      if (reconcileError) warn(`site channel cleanup incomplete: ${reconcileError}`);
      const r = siteReachability(db, updated.id);
      const pendingCleanup = r.channels.filter(
        (c) => c.status === "cleanup_pending" || c.status === "waiting_controller",
      ).length;
      const accessNow = r.publicAccess.configured ? "public" : "private";
      print(
        { id: updated.id, name: updated.name, access: accessNow, state: r.state, pendingCleanup },
        () =>
          args.action === "public"
            ? `${updated.name} is now PUBLIC at ${siteUrl(db, updated.name)}\n` +
              "注意：站点页面与管理界面同源运行，站点内脚本可以以你的身份读写整个工作区；只发布你信任的代码。"
            : `${updated.name} is now private` +
              (pendingCleanup ? ` (${pendingCleanup} channel(s) awaiting remote cleanup)` : ""),
      );
      return;
    }
    if (args.action !== undefined)
      throw new MhError("invalid_input", `unknown access action '${args.action}' — use public or private`);

    const r = siteReachability(db, site.id);
    const pub = r.publicAccess;
    const channels = r.channels.map((c) => {
      const base = {
        audience: c.audience,
        hosting: c.hosting,
        status: c.status,
        ...(c.desiredState ? { desiredState: c.desiredState } : {}),
      };
      // Capability URLs are secrets: masked by default, whole URL only on
      // explicit --show-links.
      if (c.audience === "link" && !args["show-links"])
        return { ...base, urlMasked: c.slug ? `${c.slug.slice(0, 8)}…` : null };
      return { ...base, url: c.url ?? null };
    });
    print(
      {
        id: site.id,
        name: site.name,
        access: pub.configured ? "public" : channels.length ? "link" : "private",
        state: r.state,
        ...(pub.anomaly ? { public_config_anomaly: pub.anomaly } : {}),
        channels,
      },
      () =>
        `${site.id}\t${site.name}\naccess: ${pub.configured ? "public" : "private"}\tstate: ${r.state}\n` +
        (channels.length
          ? table(
              channels.map((c) => ({
                audience: c.audience,
                hosting: c.hosting,
                status: c.status,
                url: ("url" in c ? c.url : c.urlMasked) ?? "-",
              })),
            )
          : "(no channels)"),
    );
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a whole site and its files" },
  args: { site: { type: "positional", required: true, description: "Site ref (id/name)" } },
  run: guard(async (args) => {
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    applySiteDelete(db, site.id);
    // Delete is committed; cleanup problems are warnings, not failures.
    const reconcileError = await reconcileSiteChannelsQuietly(db);
    if (reconcileError) warn(`site channel cleanup incomplete: ${reconcileError}`);
    print({ ok: true, deleted: site.id });
  }),
});

export default defineCommand({
  meta: {
    name: "site",
    description:
      "Manage static sites served at /sites/<name>/ (pages call /api/* or import /metahub-sdk.js same-origin)",
  },
  // `publish` is rewritten to `upload` with a deprecation warning in index.ts,
  // keeping existing scripts alive without advertising two competing verbs.
  subCommands: { create, update, access, scaffold, put, upload, list, files, rm, grant, grants, delete: del },
});
