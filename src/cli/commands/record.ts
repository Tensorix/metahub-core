import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
} from "../../core/records.ts";
import { resolveJson } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { resolveDb } from "../refs.ts";
import { print, table, guard } from "../output.ts";

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
  subCommands: { create, list, get, update, delete: del },
});
