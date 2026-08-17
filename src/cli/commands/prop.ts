import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  addProperty,
  listProperties,
  updateProperty,
  removeProperty,
  type PropType,
  type PropertyConfig,
} from "../../core/properties.ts";
import {
  listPropertyRevisions,
  revertProperty,
  type PropertyRevision,
} from "../../core/history.ts";
import { resolveJson } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { errorCode } from "../../core/errors.ts";
import { idKind } from "../../core/ids.ts";
import { resolveDb } from "../refs.ts";
import { print, table, guard, warn } from "../output.ts";
import type { Database } from "bun:sqlite";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

/** Duplicate names are legal (offline peers can converge on them) but make
 *  name-keyed record access ambiguous — flag it loudly when an add/rename
 *  creates one, so scripts know to switch to property ids. */
function warnIfDuplicateName(db: Database, databaseId: string, name: string): void {
  const dups = listProperties(db, databaseId).filter(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (dups.length > 1)
    warn(
      `property name "${name}" now matches ${dups.length} properties in this database; ` +
        `name-keyed record reads/writes will fail as ambiguous — use property ids (${dups.map((p) => p.id).join(", ")})`,
    );
}

/** Resolve a property ref, letting a full id of a tombstoned property pass
 *  through — revert can resurrect a removed column. */
function propIdMaybeDeleted(db: Database, ref: string): string {
  try {
    return resolveRef(db, ref, { kind: "prop" });
  } catch (e) {
    if (errorCode(e) === "not_found" && idKind(ref) === "prop") return ref;
    throw e;
  }
}

function buildConfig(args: Record<string, any>, base?: PropertyConfig): PropertyConfig | undefined {
  const config: PropertyConfig = { ...base };
  if (typeof args.options === "string")
    config.options = args.options.split(",").map((s: string) => s.trim()).filter(Boolean);
  if (typeof args.target === "string") config.database = args.target;
  return Object.keys(config).length ? config : undefined;
}

const add = defineCommand({
  meta: { name: "add", description: "Add a property (column) to a database" },
  args: {
    name: { type: "positional", required: true, description: "Property name" },
    db: { type: "string", description: "Database ref (default: current)" },
    type: { type: "string", required: true, description: "text|number|checkbox|select|multi_select|date|relation|url" },
    options: { type: "string", description: "Comma list for select/multi_select" },
    target: { type: "string", description: "Target database ref for relation" },
    config: { type: "string", description: "Raw config JSON (@file/@- ok)" },
    position: { type: "string", description: "Sort position" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const databaseId = resolveDb(db, args.db);
    const fromJson = await resolveJson<PropertyConfig>(args.config);
    const target = args.target != null ? resolveRef(db, args.target, { kind: "db" }) : undefined;
    const config = buildConfig({ ...args, target }, fromJson);
    const row = addProperty(db, databaseId, {
      name: args.name,
      type: args.type as PropType,
      config,
      position: args.position != null ? Number(args.position) : undefined,
    });
    warnIfDuplicateName(db, databaseId, row.name);
    print(row, () => `${row.id}\t${row.name}\t${row.type}`);
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List properties of a database" },
  args: {
    database: { type: "positional", required: false, description: "Database ref (default: current)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = listProperties(db, resolveDb(db, args.database));
    print(rows, () =>
      table(rows.map((r) => ({ id: r.id, name: r.name, type: r.type, position: r.position }))),
    );
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a property" },
  args: {
    id: { type: "positional", required: true, description: "Property ref (id/prefix/name)" },
    name: { type: "string" },
    options: {
      type: "string",
      description:
        "Comma list for select/multi_select; replaces the option set without migrating cell values",
    },
    target: { type: "string", description: "Target database ref for relation" },
    config: {
      type: "string",
      description: "Config JSON patch, merged key-wise; a null key is removed (@file/@- ok)",
    },
    position: { type: "string" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const fromJson = await resolveJson<PropertyConfig>(args.config);
    const target = args.target != null ? resolveRef(db, args.target, { kind: "db" }) : undefined;
    const config = buildConfig({ ...args, target }, fromJson);
    const row = updateProperty(db, resolveRef(db, args.id, { kind: "prop" }), {
      name: args.name,
      config,
      position: args.position != null ? Number(args.position) : undefined,
    });
    if (args.name != null) warnIfDuplicateName(db, row.database_id, row.name);
    print(row);
  }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove a property" },
  args: { id: { type: "positional", required: true, description: "Property ref (id/prefix/name)" } },
  run: guard((args) => {
    const db = openMetahub();
    const id = resolveRef(db, args.id, { kind: "prop" });
    removeProperty(db, id);
    print({ ok: true, removed: id });
  }),
});

function propRevisionSummary(r: PropertyRevision): string {
  const parts: string[] = [];
  if (r.kind !== "user") parts.push(`[${r.kind}]`);
  if (r.created) parts.push("created");
  if (r.deleted) parts.push("removed");
  if (r.fields.length) parts.push(r.fields.join(", "));
  if (r.cells_cleared) parts.push(`-${r.cells_cleared} cell(s)`);
  return parts.join("; ") || "metadata";
}

const history = defineCommand({
  meta: { name: "history", description: "List a property's definition revisions (newest first)" },
  args: {
    id: { type: "positional", required: true, description: "Property ref (id/prefix/name)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = listPropertyRevisions(db, propIdMaybeDeleted(db, args.id));
    print(rows, () =>
      table(
        rows.map((r) => ({
          version: r.version,
          at: r.at,
          node: r.node_id,
          summary: propRevisionSummary(r),
        })),
      ),
    );
  }),
});

const revert = defineCommand({
  meta: {
    name: "revert",
    description:
      "Restore a property's definition AND the cells its type-change/removal cleared; user edits made since are kept",
  },
  args: {
    id: { type: "positional", required: true, description: "Property ref (id/prefix/name)" },
    to: { type: "string", required: true, description: "Version token from `prop history`" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const r = revertProperty(db, propIdMaybeDeleted(db, args.id), args.to);
    print(r, () =>
      r.changed
        ? `reverted ${r.id} to ${r.restored}` +
          (r.fields.length ? ` (${r.fields.join(", ")})` : "") +
          (r.restored_cells ? ` +${r.restored_cells} cell(s)` : "") +
          (r.skipped_cells ? ` (${r.skipped_cells} kept user edits)` : "") +
          (r.undeleted ? " [undeleted]" : "")
        : `no change: ${r.id} already matches ${r.restored}`,
    );
  }),
});

export default defineCommand({
  meta: { name: "prop", description: "Manage database properties (columns)" },
  subCommands: { add, list, update, history, revert, remove },
});
