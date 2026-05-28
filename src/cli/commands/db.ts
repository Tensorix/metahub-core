import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createDatabase,
  listDatabases,
  getDatabase,
  deleteDatabase,
} from "../../core/databases.ts";
import { print, fail, table, guard } from "../output.ts";

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
  args: { id: { type: "positional", required: true, description: "Database id" } },
  run: guard((args) => {
    const row = getDatabase(openMetahub(), args.id);
    if (!row) fail(`no such database: ${args.id}`);
    print(row);
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a database" },
  args: { id: { type: "positional", required: true, description: "Database id" } },
  run: guard((args) => {
    if (!deleteDatabase(openMetahub(), args.id)) fail(`no such database: ${args.id}`);
    print({ ok: true, deleted: args.id });
  }),
});

export default defineCommand({
  meta: { name: "db", description: "Manage databases (notion-like tables)" },
  subCommands: { create, list, get, delete: del },
});
