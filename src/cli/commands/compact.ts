import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { compactOplog } from "../../core/compact.ts";
import { print, guard } from "../output.ts";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default defineCommand({
  meta: {
    name: "compact",
    description:
      "Prune oplog history older than the retention window and reclaim disk. " +
      "The current data is untouched; doc/record/prop history older than the window " +
      "collapses to a single baseline version (revert beyond it is no longer possible). " +
      "Local-only: peers keep their own history until they compact themselves.",
  },
  args: {
    keep: {
      type: "string",
      description: "Days of full history to keep (default 90; 0 = head state only)",
    },
    "dry-run": { type: "boolean", description: "Report what would be removed, change nothing" },
    "no-vacuum": { type: "boolean", description: "Skip VACUUM (faster; space is reused, not returned)" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const r = compactOplog(db, {
      keepDays: args.keep != null ? Number(args.keep) : 90,
      dryRun: args["dry-run"],
      vacuum: !args["no-vacuum"],
    });
    print(r, () => {
      const lines = [
        `oplog: ${r.deleted_changes} change(s) removed, ${r.kept_changes} kept (cutoff ${r.cutoff})`,
        `blobs: ${r.blobs_deleted} file(s), ${fmtBytes(r.blob_bytes_freed)}`,
        `db: ${fmtBytes(r.db_bytes_before)} -> ${fmtBytes(r.db_bytes_after)}`,
      ];
      if (r.dry_run) lines.push("(dry run — nothing deleted)");
      return lines.join("\n");
    });
  }),
});
