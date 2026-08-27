import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  listAuditEntries,
  auditEntryDetail,
  revertChangeGroup,
  type AuditEntry,
} from "../../core/audit.ts";
import { print, guard, table } from "../output.ts";

function summarize(e: AuditEntry): string {
  const parts = e.entities.map((ent) => {
    const what =
      ent.dataset === "records"
        ? "record"
        : ent.dataset === "documents"
          ? "doc"
          : ent.dataset === "properties"
            ? "prop"
            : ent.dataset === "databases"
              ? "db"
              : ent.dataset;
    const verb = ent.created ? "+" : ent.deleted ? "-" : "~";
    return `${verb}${what} ${ent.label ?? ent.id}`;
  });
  return parts.slice(0, 3).join(", ") + (parts.length > 3 ? ` (+${parts.length - 3} more)` : "");
}

const show = defineCommand({
  meta: {
    name: "show",
    description: "Expand one audit entry: per-field before/after values",
  },
  args: {
    txn: { type: "positional", description: "Change-group id (from `mh audit`)", required: true },
  },
  run: guard((args) => {
    const db = openMetahub();
    const d = auditEntryDetail(db, args.txn);
    print(d, () => {
      const lines = [`${d.at}  ${d.actor ?? d.node_id}  ${d.kind}  txn=${d.txn}`];
      for (const ent of d.entities) {
        lines.push(`  ${ent.dataset} ${ent.label ?? ent.id}${ent.created ? " (created)" : ent.deleted ? " (deleted)" : ""}`);
        for (const f of ent.diffs)
          lines.push(`    ${f.label}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`);
        for (const b of ent.block_diffs)
          lines.push(`    block: ${JSON.stringify(b.before)} -> ${JSON.stringify(b.after)}`);
      }
      return lines.join("\n");
    });
  }),
});

const revert = defineCommand({
  meta: {
    name: "revert",
    description:
      "Undo one change group as a new forward revision. Registers overwritten " +
      "since are kept (reported as skipped); the revert itself is revertible.",
  },
  args: {
    txn: { type: "positional", description: "Change-group id (from `mh audit`)", required: true },
  },
  run: guard((args) => {
    const db = openMetahub();
    const r = revertChangeGroup(db, args.txn);
    print(r, () =>
      [
        `restored ${r.restored_registers} register(s), removed ${r.removed_rows} created row(s)`,
        r.skipped_registers || r.skipped_rows
          ? `kept ${r.skipped_registers} register(s) / ${r.skipped_rows} row(s) with later edits`
          : null,
        r.changed ? null : "nothing to revert (already converged)",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }),
});

const runList = guard((args: Record<string, any>) => {
  const db = openMetahub();
  const page = listAuditEntries(db, {
    limit: args.limit != null ? Number(args.limit) : undefined,
    actor: args.actor,
    before: args.before,
  });
  print(page, () => {
    const rows = page.entries.map((e) => ({
      at: e.at.replace("T", " ").slice(0, 19),
      actor: e.actor ?? "-",
      kind: e.kind,
      summary: summarize(e),
      txn: e.txn ?? "(legacy)",
    }));
    const out = table(rows);
    return page.next ? out + `\nmore: mh audit list --before ${page.next}` : out;
  });
});

const LIST_ARGS = {
  limit: { type: "string", description: "Max entries (default 50)" },
  actor: { type: "string", description: "Only entries by this actor tag (e.g. ai)" },
  before: { type: "string", description: "Page older entries (the `next` cursor)" },
} as const;

const list = defineCommand({
  meta: { name: "list", description: "List audit entries (the default subcommand)" },
  args: LIST_ARGS,
  run: (ctx) => runList(ctx),
});

export default defineCommand({
  meta: {
    name: "audit",
    description:
      "The global change feed: every edit across the whole hub, newest first, " +
      "grouped into logical changes with their actor (e.g. agent-driven CLI " +
      "writes are tagged 'ai'). Depth is bounded by the compaction window.",
  },
  // Flags live on the `list` subcommand (citty would read a bare root flag
  // value as a subcommand name); a bare `mh audit` still lists with defaults.
  subCommands: { list, show, revert },
  run: (ctx) => {
    if (Object.keys(ctx.args).filter((k) => k !== "_").length === 0 && ctx.args._.length === 0)
      return runList(ctx);
  },
});
