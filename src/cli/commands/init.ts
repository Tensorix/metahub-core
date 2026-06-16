import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { getNodeId } from "../../core/node.ts";
import { metahubHome, cacheDir } from "../../core/paths.ts";
import { print } from "../output.ts";
import { scaffoldClaudeSkill } from "../claude-skill.ts";

export default defineCommand({
  meta: {
    name: "init",
    description: "Create ~/.metahub (SQLite database + cache directory)",
  },
  args: {
    claude: {
      type: "boolean",
      description:
        "Install a Claude Code /mh skill into ~/.claude (does not touch ~/.metahub)",
    },
  },
  async run({ args }) {
    // `--claude` is a standalone installer for the Claude Code integration; it
    // writes only into ~/.claude and never creates ~/.metahub (plain `mh init`
    // owns that), so short-circuit before opening the database.
    if (args.claude) {
      const r = await scaffoldClaudeSkill();
      print({ changed: r.changed, skill: r.path }, () =>
        (r.changed ? `Installed ${r.path}` : `Up to date: ${r.path}`) +
        "\nUse /mh in Claude Code (any project).",
      );
      return;
    }
    const db = openMetahub();
    const nodeId = getNodeId(db);
    const home = metahubHome();
    print({ ok: true, home, cache: cacheDir(), nodeId }, () =>
      `Initialized ${home} (node ${nodeId})`,
    );
  },
});
