// `mh init --claude` / `mh init --codex` install the metahub usage guide as a
// personal agent skill, so every project the user opens can get a short `/mh` or
// `$mh` entrypoint plus auto-loaded reference for this CLI.
//
// The skill body is the repo-root SKILL.md, embedded at build time so the
// shipped binary can never drift from the checked-in doc (Bun inlines the text
// import; see src/cli/compiled-entry.ts for the same loader on the dist bundles).
// In Claude Code a skill at `<config>/skills/<dir>/SKILL.md` *is* the `/<dir>`
// slash command, and the directory name — not the frontmatter — sets the name,
// so this lands under `skills/mh/` to yield `/mh`. Codex discovers personal
// skills from `$CODEX_HOME/skills` (or `~/.codex/skills`) and uses `name: mh`
// plus optional `agents/openai.yaml` UI metadata for `$mh`.
import SKILL_MD from "../../SKILL.md" with { type: "text" };
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_OPENAI_YAML = `interface:
  display_name: "Metahub"
  short_description: "Use mh for durable agent memory"
  default_prompt: "Use $mh to store, recall, search, and edit durable working memory with metahub."
`;

/** Personal Claude config dir: ~/.claude, relocatable via CLAUDE_CONFIG_DIR. */
function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Personal Codex config dir: ~/.codex, relocatable via CODEX_HOME. */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export interface ScaffoldResult {
  /** Absolute path of the installed SKILL.md. */
  path: string;
  /** False when the file already matched (idempotent no-op). */
  changed: boolean;
}

export interface CodexScaffoldResult extends ScaffoldResult {
  /** Absolute path of the Codex UI metadata file. */
  metadataPath: string;
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const prev = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
  if (prev === content) return false;
  await Bun.write(path, content);
  return true;
}

/**
 * Install (or refresh) the `/mh` skill under the personal Claude config dir.
 * Idempotent: skips the write when the on-disk copy already matches, so callers
 * can report honest effect-evidence instead of a blanket success.
 */
export async function scaffoldClaudeSkill(): Promise<ScaffoldResult> {
  const dir = join(claudeHome(), "skills", "mh");
  const path = join(dir, "SKILL.md");
  mkdirSync(dir, { recursive: true });
  const changed = await writeIfChanged(path, SKILL_MD);
  return { path, changed };
}

/**
 * Install (or refresh) the `$mh` skill under the personal Codex config dir.
 * Writes Codex UI metadata next to the shared SKILL.md and reports changed when
 * either file had to be created or refreshed.
 */
export async function scaffoldCodexSkill(): Promise<CodexScaffoldResult> {
  const dir = join(codexHome(), "skills", "mh");
  const path = join(dir, "SKILL.md");
  const metadataDir = join(dir, "agents");
  const metadataPath = join(metadataDir, "openai.yaml");
  mkdirSync(metadataDir, { recursive: true });
  const skillChanged = await writeIfChanged(path, SKILL_MD);
  const metadataChanged = await writeIfChanged(metadataPath, CODEX_OPENAI_YAML);
  return { path, metadataPath, changed: skillChanged || metadataChanged };
}
