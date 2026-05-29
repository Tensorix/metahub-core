import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { syncWithPeer } from "../../core/sync/client.ts";
import { syncFiles } from "../../core/sync/files.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: {
    name: "sync",
    description:
      "Push/pull against a sync server (sync <url>), or export/import a doc or table to a file (sync <src> <dst>)",
  },
  args: {
    src: {
      type: "positional",
      required: true,
      description: "Server URL (peer sync) — or a doc/table ref or file path (file sync)",
    },
    dst: {
      type: "positional",
      required: false,
      description: "File path or entity ref; when given, export/import instead of peer sync",
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    if (args.dst == null) {
      const result = await syncWithPeer(db, args.src);
      return print(result, () => `pushed ${result.pushed}, pulled ${result.pulled}`);
    }
    const r = await syncFiles(db, args.src, args.dst);
    print(
      r,
      () => `${r.direction} ${r.kind} ${r.id} ${r.direction === "export" ? "→" : "←"} ${r.path}`,
    );
  }),
});
