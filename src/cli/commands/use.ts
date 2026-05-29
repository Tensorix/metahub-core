import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { resolveRef } from "../../core/resolve.ts";
import { getDatabase } from "../../core/databases.ts";
import {
  getCurrentDatabase,
  setCurrentDatabase,
  clearCurrentDatabase,
} from "../../core/context.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: {
    name: "use",
    description: "Set/show the current database (record, doc, prop default to it)",
  },
  args: {
    database: {
      type: "positional",
      required: false,
      description: "Database ref (id/prefix/name); omit to show current",
    },
    clear: { type: "boolean", description: "Clear the current database" },
  },
  run: guard((args) => {
    const db = openMetahub();
    if (args.clear) {
      clearCurrentDatabase(db);
      print({ ok: true, current: null }, () => "✓ current database cleared");
      return;
    }
    if (args.database == null) {
      const cur = getCurrentDatabase(db);
      print({ current: cur }, () =>
        cur ? `${cur.id}\t${cur.name}` : "(no current database)",
      );
      return;
    }
    const id = resolveRef(db, args.database, { kind: "db" });
    setCurrentDatabase(db, id);
    const row = getDatabase(db, id)!;
    print(
      { ok: true, current: row },
      () => `✓ current database → ${row.name} (${row.id})`,
    );
  }),
});
