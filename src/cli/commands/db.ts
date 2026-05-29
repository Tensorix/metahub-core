import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createDatabase,
  listDatabases,
  getDatabase,
  deleteDatabase,
} from "../../core/databases.ts";
import { resolveRef } from "../../core/resolve.ts";
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
  subCommands: { create, list, get, delete: del },
});
