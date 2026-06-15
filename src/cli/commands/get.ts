import { defineCommand } from "citty";
import { resolveEntity } from "../../core/resolve.ts";
import { getDatabase } from "../../core/databases.ts";
import { getProperty } from "../../core/properties.ts";
import { getRecord } from "../../core/records.ts";
import { getDocument } from "../../core/documents.ts";
import { print, table, guard } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

/**
 * Type-agnostic lookup: resolve a ref across databases/properties/records/
 * documents (dispatched by type prefix when present) and print the entity.
 */
export default defineCommand({
  meta: { name: "get", description: "Look up any entity by ref (id/prefix/name), type auto-detected" },
  args: { ref: { type: "positional", required: true, description: "Ref (id/prefix/name)" }, ...FRESH_ARGS },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const { kind, id } = resolveEntity(db, args.ref);
    switch (kind) {
      case "db": {
        const row = getDatabase(db, id)!;
        return print(row, () => `${row.id}\t${row.name}`);
      }
      case "prop": {
        const row = getProperty(db, id)!;
        return print(row, () => table([{ id: row.id, name: row.name, type: row.type }]));
      }
      case "rec":
        return print(getRecord(db, id));
      case "doc": {
        const row = getDocument(db, id)!;
        return print(row, () => row.body ?? "");
      }
    }
  }),
});
