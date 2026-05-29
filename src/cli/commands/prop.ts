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
import { resolveJson } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { resolveDb } from "../refs.ts";
import { print, table, guard } from "../output.ts";

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
    print(row, () => `${row.id}\t${row.name}\t${row.type}`);
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List properties of a database" },
  args: { database: { type: "positional", required: false, description: "Database ref (default: current)" } },
  run: guard((args) => {
    const db = openMetahub();
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
    options: { type: "string", description: "Comma list for select/multi_select" },
    target: { type: "string", description: "Target database ref for relation" },
    config: { type: "string", description: "Raw config JSON (@file/@- ok)" },
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

export default defineCommand({
  meta: { name: "prop", description: "Manage database properties (columns)" },
  subCommands: { add, list, update, remove },
});
