import { defineCommand } from "citty";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openMetahub } from "../../core/db.ts";
import {
  createSite,
  getSiteByName,
  listSites,
  deleteSite,
  resolveSite,
  putFile,
  listFiles,
  deleteFile,
} from "../../core/sites.ts";
import { resolveValue } from "../input.ts";
import { errorCode, MhError } from "../../core/errors.ts";
import { print, table, guard } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

const create = defineCommand({
  meta: { name: "create", description: "Create a static site (bucket)" },
  args: {
    name: { type: "positional", required: true, description: "Site name (URL slug)" },
    title: { type: "string", description: "Human-readable title" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const site = createSite(db, { name: args.name, title: args.title });
    print({ id: site.id, name: site.name }, () => `${site.id}\t${site.name}`);
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

const publish = defineCommand({
  meta: {
    name: "publish",
    description: "Upload every file in a directory to a site (--create to create a missing site)",
  },
  args: {
    site: { type: "positional", required: true, description: "Site ref (id/name)" },
    dir: { type: "positional", required: true, description: "Local directory to publish" },
    create: { type: "boolean", description: "Create the site if it doesn't exist" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const site = resolveSiteForPublish(db, args.site, Boolean(args.create));
    const rels = [...new Bun.Glob("**/*").scanSync({ cwd: args.dir, onlyFiles: true })].sort();
    if (rels.length === 0) throw new Error(`no files found in ${args.dir}`);
    const uploaded: string[] = [];
    for (const rel of rels) {
      const bytes = new Uint8Array(await Bun.file(join(args.dir, rel)).arrayBuffer());
      await putFile(db, site.id, rel, { data: bytes });
      uploaded.push(rel);
    }
    print(
      { site: site.id, name: site.name, files: uploaded.length, paths: uploaded },
      () => `published ${uploaded.length} file(s) to ${site.name}:\n  ${uploaded.join("\n  ")}`,
    );
  }),
});

/** Site creation on publish is opt-in (--create): a typo'd site name must fail
 *  loudly, not silently mint a new site and publish into it. */
function resolveSiteForPublish(db: Database, ref: string, create: boolean) {
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
  meta: { name: "list", description: "List sites" },
  args: { ...FRESH_ARGS },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = listSites(db);
    print(rows, () => table(rows.map((r) => ({ id: r.id, name: r.name, title: r.title ?? "" }))));
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

const del = defineCommand({
  meta: { name: "delete", description: "Delete a whole site and its files" },
  args: { site: { type: "positional", required: true, description: "Site ref (id/name)" } },
  run: guard((args) => {
    const db = openMetahub();
    const site = resolveSite(db, args.site);
    deleteSite(db, site.id);
    print({ ok: true, deleted: site.id });
  }),
});

export default defineCommand({
  meta: { name: "site", description: "Manage static sites served at /sites/<name>/" },
  subCommands: { create, put, publish, list, files, rm, delete: del },
});
