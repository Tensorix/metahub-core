import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createDatabase,
  listDatabases,
  getDatabase,
  duplicateDatabase,
  deleteDatabase,
} from "../../core/databases.ts";
import { listDatabaseActivity, type DatabaseActivityEntry } from "../../core/history.ts";
import { listProperties } from "../../core/properties.ts";
import { resolveRef } from "../../core/resolve.ts";
import { resolveDb } from "../refs.ts";
import { print, table, guard } from "../output.ts";

const create = defineCommand({
  meta: { name: "create", description: "Create a database" },
  args: {
    name: { type: "positional", required: true, description: "Database name" },
    icon: { type: "string", description: "Optional icon" },
  },
  run: guard((args) => {
    const row = createDatabase(openMetahub(), { name: args.name, icon: args.icon });
    print(row, () => `${row.id}\t${row.name}`);
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List databases" },
  run: guard(() => {
    const rows = listDatabases(openMetahub());
    print(rows, () => table(rows));
  }),
});

const get = defineCommand({
  meta: { name: "get", description: "Show one database" },
  args: { id: { type: "positional", required: true, description: "Database ref (id/prefix/name)" } },
  run: guard((args) => {
    const db = openMetahub();
    print(getDatabase(db, resolveRef(db, args.id, { kind: "db" })));
  }),
});

const duplicate = defineCommand({
  meta: { name: "duplicate", description: "Copy a database whole — schema and all records" },
  args: {
    id: { type: "positional", required: true, description: "Database ref (id/prefix/name)" },
    name: { type: "string", description: "Name for the copy (defaults to the source name)" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const row = duplicateDatabase(db, resolveRef(db, args.id, { kind: "db" }), { name: args.name });
    print(row, () => `${row.id}\t${row.name}`);
  }),
});

/** A cell value for the one-line summary: short, never multiline. */
function fmtCell(v: unknown): string {
  const s =
    v === undefined || v === null || v === ""
      ? "(empty)"
      : typeof v === "string"
        ? v.replaceAll("\n", "⏎")
        : JSON.stringify(v);
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}

function activitySummary(e: DatabaseActivityEntry, names: Map<string, string>): string {
  const parts: string[] = [];
  if (e.kind !== "user") parts.push(`[${e.kind}]`);
  if (e.deleted) parts.push("deleted");
  if (e.created) {
    const vals = e.diffs
      .filter((d) => "after" in d)
      .map((d) => `${names.get(d.prop) ?? d.prop}: ${fmtCell(d.after)}`);
    parts.push("created" + (vals.length ? ` (${vals.join(", ")})` : ""));
  } else if (e.diffs.length) {
    parts.push(
      e.diffs
        .map((d) => `${names.get(d.prop) ?? d.prop}: ${fmtCell(d.before)} → ${fmtCell(d.after)}`)
        .join("; "),
    );
  }
  if (e.moved && !parts.length) parts.push("moved");
  return parts.join("; ") || "metadata";
}

const activity = defineCommand({
  meta: {
    name: "activity",
    description: "Recent changes across ALL records of a database, newest first",
  },
  args: {
    id: { type: "positional", required: false, description: "Database ref (default: current)" },
    limit: { type: "string", description: "Max entries (default 100)" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const databaseId = resolveDb(db, args.id);
    const rows = listDatabaseActivity(db, databaseId, {
      limit: args.limit != null ? Number(args.limit) : undefined,
    });
    const names = new Map(listProperties(db, databaseId).map((p) => [p.id, p.name]));
    print(rows, () =>
      table(
        rows.map((e) => ({
          version: e.version,
          at: e.at,
          node: e.node_id,
          record: e.record_title || e.record_id,
          summary: activitySummary(e, names),
        })),
      ),
    );
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a database" },
  args: { id: { type: "positional", required: true, description: "Database ref (id/prefix/name)" } },
  run: guard((args) => {
    const db = openMetahub();
    const id = resolveRef(db, args.id, { kind: "db" });
    deleteDatabase(db, id);
    print({ ok: true, deleted: id });
  }),
});

export default defineCommand({
  meta: { name: "db", description: "Manage databases (notion-like tables)" },
  subCommands: { create, list, get, duplicate, activity, delete: del },
});
