import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { validateHub } from "../../core/integrity.ts";
import { compactEstimate } from "../../core/compact.ts";
import { print, table } from "../output.ts";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Scan the hub for logical-integrity issues (read-only; run `mh repair` to fix)",
  },
  run: () => {
    const db = openMetahub();
    const report = validateHub(db);
    const storage = compactEstimate(db, 90);
    print({ ...report, storage }, () => {
      const mb = (storage.db_bytes / 1024 / 1024).toFixed(1);
      const storageLine =
        `storage: ${storage.total_changes} oplog change(s), ${mb} MB on disk` +
        (storage.compactable_changes
          ? `; ${storage.compactable_changes} prunable with \`mh compact\` (90d window)`
          : "");
      if (report.ok) return `No integrity issues found.\n${storageLine}`;
      const head = `${report.total} issue(s): ${Object.entries(report.counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`;
      const rows = report.issues.map((i) => ({
        category: i.category,
        entity: i.entity,
        id: i.id,
        fix: i.fixable ? "auto" : "report",
        detail: i.detail,
      }));
      return `${head}\n\n${table(rows)}\n\n${storageLine}`;
    });
  },
});
