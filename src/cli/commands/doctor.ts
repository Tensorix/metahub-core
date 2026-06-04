import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { validateHub } from "../../core/integrity.ts";
import { print, table } from "../output.ts";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Scan the hub for logical-integrity issues (read-only; run `mh repair` to fix)",
  },
  run: () => {
    const report = validateHub(openMetahub());
    print(report, () => {
      if (report.ok) return "No integrity issues found.";
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
      return `${head}\n\n${table(rows)}`;
    });
  },
});
