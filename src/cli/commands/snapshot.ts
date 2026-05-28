import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { createSnapshot, writeSnapshot } from "../../core/snapshot.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: {
    name: "snapshot",
    description: "Package the current metahub data into a portable file",
  },
  args: {
    out: {
      type: "positional",
      required: true,
      description: "Output path, e.g. backup.mhpack",
    },
  },
  run: guard(async (args) => {
    const info = await writeSnapshot(await createSnapshot(openMetahub()), args.out);
    print({ ok: true, path: args.out, ...info.counts, bytes: info.bytes }, () =>
      `Snapshot -> ${args.out} (${info.counts.changes} changes, ${info.counts.blobs} blobs, ${info.bytes} bytes)`,
    );
  }),
});
