import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { repairHub, validateHub } from "../../core/integrity.ts";
import { print, table } from "../output.ts";

export default defineCommand({
  meta: {
    name: "repair",
    description: "Deterministically fix logical-integrity issues (idempotent; replicates over sync)",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Report what would be fixed without changing anything (same as `mh doctor`)",
    },
  },
  run: ({ args }) => {
    const db = openMetahub();

    if (args["dry-run"]) {
      const report = validateHub(db);
      const fixable = report.issues.filter((i) => i.fixable);
      print({ dryRun: true, ...report }, () =>
        report.ok
          ? "No integrity issues found."
          : `Would fix ${fixable.length} of ${report.total} issue(s); ${report.total - fixable.length} report-only.\n\n` +
            table(
              report.issues.map((i) => ({
                category: i.category,
                id: i.id,
                fix: i.fixable ? "auto" : "report",
                detail: i.detail,
              })),
            ),
      );
      return;
    }

    const result = repairHub(db);
    print(result, () => {
      const fixed = Object.entries(result.fixed)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      const head =
        result.applied === 0
          ? "No fixable issues."
          : `Applied ${result.applied} repair(s): ${fixed}`;
      const left = result.remaining.issues;
      if (left.length === 0) return head;
      return (
        `${head}\n${left.length} report-only issue(s) need manual attention:\n\n` +
        table(left.map((i) => ({ category: i.category, id: i.id, detail: i.detail })))
      );
    });
  },
});
