import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { readSnapshot, restoreSnapshot } from "../../core/snapshot.ts";
import { print, guard } from "../output.ts";

export default defineCommand({
  meta: {
    name: "restore",
    description:
      "Restore metahub data from a package (merge by default, --reset to replace)",
  },
  args: {
    file: {
      type: "positional",
      required: true,
      description: "Package path to restore from",
    },
    reset: {
      type: "boolean",
      description:
        "Replace local data instead of merging (destructive; saves a safety snapshot first)",
    },
    force: {
      type: "boolean",
      description: "Required with --reset to confirm the destructive replace",
    },
  },
  run: guard(async (args) => {
    const pkg = await readSnapshot(args.file);
    const result = await restoreSnapshot(openMetahub(), pkg, {
      reset: !!args.reset,
      force: !!args.force,
    });
    print(result, () =>
      result.mode === "reset"
        ? `Restored (reset) from ${args.file}: ${result.applied} changes, ${result.blobs} blobs. Safety snapshot: ${result.safetyPath}`
        : `Merged ${args.file}: ${result.applied} new changes, ${result.blobs} blobs`,
    );
  }),
});
