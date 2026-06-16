// `mh init --claude` installs the metahub usage guide as a personal Claude Code
// skill, so every project the user opens gets a `/mh` slash command plus
// auto-loaded reference for this CLI.
//
// The skill body is the repo-root SKILL.md, embedded at build time so the
// shipped binary can never drift from the checked-in doc (Bun inlines the text
// import; see src/cli/compiled-entry.ts for the same loader on the dist bundles).
// In Claude Code a skill at `<config>/skills/<dir>/SKILL.md` *is* the `/<dir>`
// slash command, and the directory name — not the frontmatter — sets the name,
// so this lands under `skills/mh/` to yield `/mh`.
import SKILL_MD from "../../SKILL.md" with { type: "text" };
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Personal Claude config dir: ~/.claude, relocatable via CLAUDE_CONFIG_DIR. */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export interface ScaffoldResult {
  /** Absolute path of the installed SKILL.md. */
  path: string;
  /** False when the file already matched (idempotent no-op). */
  changed: boolean;
}

/**
 * Install (or refresh) the `/mh` skill under the personal Claude config dir.
 * Idempotent: skips the write when the on-disk copy already matches, so callers
 * can report honest effect-evidence instead of a blanket success.
 */
export async function scaffoldClaudeSkill(): Promise<ScaffoldResult> {
  const dir = join(claudeHome(), "skills", "mh");
  const path = join(dir, "SKILL.md");
  const prev = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
  const changed = prev !== SKILL_MD;
  if (changed) {
    mkdirSync(dir, { recursive: true });
    await Bun.write(path, SKILL_MD);
  }
  return { path, changed };
}
