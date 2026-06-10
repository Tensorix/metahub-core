import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
} from "../../core/records.ts";
import {
  listRecordRevisions,
  revertRecord,
  recordFieldHistory,
  type RecordRevision,
} from "../../core/history.ts";
import { listProperties } from "../../core/properties.ts";
import { resolveJson } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { errorCode, MhError } from "../../core/errors.ts";
import { idKind } from "../../core/ids.ts";
import { resolveDb } from "../refs.ts";
import { print, table, guard } from "../output.ts";
import type { Database } from "bun:sqlite";

/** Resolve a record ref, letting a full id of a tombstoned record pass through —
 *  history and revert must reach deleted records (revert resurrects them). */
function recIdMaybeDeleted(db: Database, ref: string): string {
  try {
    return resolveRef(db, ref, { kind: "rec" });
  } catch (e) {
    if (errorCode(e) === "not_found" && idKind(ref) === "rec") return ref;
    throw e;
  }
}

/** Property-id -> display-name map for the database a record belongs to. */
function propNames(db: Database, recordId: string): Map<string, string> {
  const row = db
    .query("SELECT database_id FROM records WHERE id = ?")
    .get(recordId) as { database_id: string | null } | null;
  if (!row?.database_id) return new Map();
  return new Map(listProperties(db, row.database_id).map((p) => [p.id, p.name]));
}

function flatten(r: { id: string; values: Record<string, unknown> }) {
  const out: Record<string, unknown> = { id: r.id };
  for (const [k, v] of Object.entries(r.values))
    out[k] = v != null && typeof v === "object" ? JSON.stringify(v) : v;
  return out;
}

const create = defineCommand({
  meta: { name: "create", description: "Create a record (row)" },
  args: {
    database: { type: "positional", required: false, description: "Database ref (default: current)" },
    data: { type: "string", description: "JSON of {column: value} (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const data = (await resolveJson<Record<string, unknown>>(args.data)) ?? {};
    const row = createRecord(db, resolveDb(db, args.database), data);
    print(row, () => row.id);
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List records in a database" },
  args: {
    database: { type: "positional", required: false, description: "Database ref (default: current)" },
    filter: { type: "string", description: "JSON of {column: value} (@file/@- ok)" },
    sort: { type: "string", description: "Sort field (default created)" },
    desc: { type: "boolean", description: "Sort descending" },
    limit: { type: "string", description: "Max rows" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const databaseId = resolveDb(db, args.database);
    const filter = await resolveJson<Record<string, unknown>>(args.filter);
    // Core takes a single sort string ("-field" = desc); compose from --desc so
    // the natural `--sort created --desc` works (a bare "-field" value gets
    // swallowed by arg parsing).
    const sort = args.sort
      ? (args.desc ? "-" : "") + args.sort.replace(/^-/, "")
      : args.desc
        ? "-created"
        : undefined;
    const rows = listRecords(db, databaseId, {
      filter,
      sort,
      limit: args.limit != null ? Number(args.limit) : undefined,
    });
    print(
      { database: databaseId, count: rows.length, records: rows },
      () => table(rows.map(flatten)),
    );
  }),
});

const get = defineCommand({
  meta: { name: "get", description: "Show one record" },
  args: { id: { type: "positional", required: true, description: "Record ref (id/prefix)" } },
  run: guard((args) => {
    const db = openMetahub();
    print(getRecord(db, resolveRef(db, args.id, { kind: "rec" })));
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "Update record cells (partial)" },
  args: {
    id: { type: "positional", required: true, description: "Record ref (id/prefix)" },
    data: { type: "string", description: "JSON of {column: value} (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const data = (await resolveJson<Record<string, unknown>>(args.data)) ?? {};
    const row = updateRecord(db, resolveRef(db, args.id, { kind: "rec" }), data);
    print(row);
  }),
});

function recordRevisionSummary(r: RecordRevision, names: Map<string, string>): string {
  const parts: string[] = [];
  if (r.created) parts.push("created");
  if (r.deleted) parts.push("deleted");
  if (r.fields.length)
    parts.push(r.fields.map((f) => names.get(f) ?? f).join(", "));
  if (r.moved && !parts.length) parts.push("moved");
  return parts.join("; ") || "metadata";
}

const history = defineCommand({
  meta: { name: "history", description: "List a record's revisions (newest first)" },
  args: {
    id: { type: "positional", required: true, description: "Record ref (id/prefix)" },
    field: { type: "string", description: "Show the value trail of one field instead" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const id = recIdMaybeDeleted(db, args.id);
    const names = propNames(db, id);
    if (args.field !== undefined) {
      const propId =
        [...names.entries()].find(
          ([pid, name]) => pid === args.field || name.toLowerCase() === args.field.toLowerCase(),
        )?.[0] ?? null;
      if (!propId) throw new MhError("not_found", `unknown property: ${args.field}`);
      const rows = recordFieldHistory(db, id, propId);
      print(rows, () =>
        table(
          rows.map((r) => ({
            version: r.version,
            at: r.at,
            node: r.node_id,
            value: r.cleared ? "(cleared)" : JSON.stringify(r.value),
          })),
        ),
      );
      return;
    }
    const rows = listRecordRevisions(db, id);
    print(rows, () =>
      table(
        rows.map((r) => ({
          version: r.version,
          at: r.at,
          node: r.node_id,
          summary: recordRevisionSummary(r, names),
        })),
      ),
    );
  }),
});

const revert = defineCommand({
  meta: {
    name: "revert",
    description: "Restore a record's cells to a past version (recorded as a new revision)",
  },
  args: {
    id: { type: "positional", required: true, description: "Record ref (id/prefix)" },
    to: { type: "string", required: true, description: "Version token from `record history`" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const id = recIdMaybeDeleted(db, args.id);
    const r = revertRecord(db, id, args.to);
    const names = propNames(db, id);
    print(r, () =>
      r.changed
        ? `reverted ${r.id} to ${r.restored}` +
          (r.fields.length
            ? ` (${r.fields.map((f) => names.get(f) ?? f).join(", ")})`
            : "") +
          (r.undeleted ? " [undeleted]" : "")
        : `no change: ${r.id} already matches ${r.restored}`,
    );
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a record" },
  args: { id: { type: "positional", required: true, description: "Record ref (id/prefix)" } },
  run: guard((args) => {
    const db = openMetahub();
    const id = resolveRef(db, args.id, { kind: "rec" });
    deleteRecord(db, id);
    print({ ok: true, deleted: id });
  }),
});

export default defineCommand({
  meta: { name: "record", description: "Manage records (rows)" },
  subCommands: { create, list, get, update, history, revert, delete: del },
});
