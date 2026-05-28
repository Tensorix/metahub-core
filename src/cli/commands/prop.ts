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
import { print, fail, table, guard } from "../output.ts";

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
    database: { type: "positional", required: true, description: "Database id" },
    name: { type: "positional", required: true, description: "Property name" },
    type: { type: "string", required: true, description: "text|number|checkbox|select|multi_select|date|relation|url" },
    options: { type: "string", description: "Comma list for select/multi_select" },
    target: { type: "string", description: "Target database id for relation" },
    config: { type: "string", description: "Raw config JSON (@file/@- ok)" },
    position: { type: "string", description: "Sort position" },
  },
  run: guard(async (args) => {
    const fromJson = await resolveJson<PropertyConfig>(args.config);
    const config = buildConfig(args, fromJson);
    const row = addProperty(openMetahub(), args.database, {
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
  args: { database: { type: "positional", required: true, description: "Database id" } },
  run: guard((args) => {
    const rows = listProperties(openMetahub(), args.database);
    print(rows, () =>
      table(rows.map((r) => ({ id: r.id, name: r.name, type: r.type, position: r.position }))),
    );
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a property" },
  args: {
    id: { type: "positional", required: true, description: "Property id" },
    name: { type: "string" },
    options: { type: "string", description: "Comma list for select/multi_select" },
    target: { type: "string", description: "Target database id for relation" },
    config: { type: "string", description: "Raw config JSON (@file/@- ok)" },
    position: { type: "string" },
  },
  run: guard(async (args) => {
    const fromJson = await resolveJson<PropertyConfig>(args.config);
    const config = buildConfig(args, fromJson);
    const row = updateProperty(openMetahub(), args.id, {
      name: args.name,
      config,
      position: args.position != null ? Number(args.position) : undefined,
    });
    print(row);
  }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove a property" },
  args: { id: { type: "positional", required: true, description: "Property id" } },
  run: guard((args) => {
    if (!removeProperty(openMetahub(), args.id)) fail(`no such property: ${args.id}`);
    print({ ok: true, removed: args.id });
  }),
});

export default defineCommand({
  meta: { name: "prop", description: "Manage database properties (columns)" },
  subCommands: { add, list, update, remove },
});
