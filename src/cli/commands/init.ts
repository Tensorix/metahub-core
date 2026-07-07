import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { getNodeId } from "../../core/node.ts";
import { metahubHome, cacheDir } from "../../core/paths.ts";
import { print } from "../output.ts";
import { scaffoldClaudeSkill, scaffoldCodexSkill } from "../agent-skill.ts";

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
    codex: {
      type: "boolean",
      description:
        "Install a Codex $mh skill into ~/.codex (does not touch ~/.metahub)",
    },
  },
  async run({ args }) {
    // Agent integration installers write only into their respective agent config
    // dirs and never create ~/.metahub (plain `mh init` owns that), so
    // short-circuit before opening the database.
    if (args.claude || args.codex) {
      const claude = args.claude ? await scaffoldClaudeSkill() : null;
      const codex = args.codex ? await scaffoldCodexSkill() : null;

      if (claude && !codex) {
        print({ changed: claude.changed, skill: claude.path }, () =>
          (claude.changed ? `Installed ${claude.path}` : `Up to date: ${claude.path}`) +
          "\nUse /mh in Claude Code (any project).",
        );
        return;
      }

      if (codex && !claude) {
        print(
          { changed: codex.changed, skill: codex.path, metadata: codex.metadataPath },
          () =>
            (codex.changed ? `Installed ${codex.path}` : `Up to date: ${codex.path}`) +
            "\nUse $mh in Codex (restart Codex if it was already running).",
        );
        return;
      }

      print(
        {
          changed: !!claude?.changed || !!codex?.changed,
          claude: claude ? { changed: claude.changed, skill: claude.path } : null,
          codex: codex ? { changed: codex.changed, skill: codex.path, metadata: codex.metadataPath } : null,
        },
        () => {
          const lines: string[] = [];
          if (claude) {
            lines.push(
              (claude.changed ? `Installed ${claude.path}` : `Up to date: ${claude.path}`) +
              "\nUse /mh in Claude Code (any project).",
            );
          }
          if (codex) {
            lines.push(
              (codex.changed ? `Installed ${codex.path}` : `Up to date: ${codex.path}`) +
              "\nUse $mh in Codex (restart Codex if it was already running).",
            );
          }
          return lines.join("\n");
        },
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
