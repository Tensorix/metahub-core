/**
 * Smoke-test that a *compiled* CLI binary carries the embedded `/mh` / `$mh`
 * skill.
 *
 * `mh init --claude` / `mh init --codex` write the repo-root SKILL.md, embedded
 * at build time as a Bun text import (src/cli/agent-skill.ts). A compiled binary
 * has no source tree, so if that embed ever stops riding into the binary, the
 * installers would write an empty/garbage file with no error. `bun test` can't
 * catch this — it runs from source and the import resolves off disk. We run the
 * binary from a throwaway cwd with no SKILL.md anywhere near it, which is the
 * real proof the bytes are inside.
 *
 * Run standalone: `bun run scripts/smoke-skill.ts <path-to-binary>`
 * Or import and call smokeSkill(binaryPath) from the build script.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assertSkillBody(path: string): number {
  const body = readFileSync(path, "utf8");
  if (body.length === 0) throw new Error("installed SKILL.md is empty");
  if (!body.startsWith("---\n") || !body.includes("name: mh")) {
    throw new Error("installed SKILL.md is missing the expected frontmatter");
  }
  if (!body.includes("durable, syncable working memory")) {
    throw new Error("installed SKILL.md is missing the embedded guide body");
  }
  return body.length;
}

/** Throws if the binary can't install non-empty, well-formed mh agent skills. */
export async function smokeSkill(binaryPath: string): Promise<void> {
  // Isolated config dir AND cwd: no source tree, no sibling SKILL.md — so a pass
  // can only mean the doc is embedded in the binary itself. Resolve the binary to
  // an absolute path first, since we run it from that throwaway cwd.
  const bin = resolve(binaryPath);
  const cfg = mkdtempSync(join(tmpdir(), "mh-skill-smoke-"));
  try {
    const claude = spawnSync(bin, ["init", "--claude", "--json"], {
      cwd: cfg,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      encoding: "utf8",
    });
    if (claude.error) throw claude.error;
    if (claude.status !== 0) {
      throw new Error(`init --claude exited ${claude.status}: ${claude.stderr || claude.stdout}`);
    }
    const claudeOut = JSON.parse(claude.stdout.trim()) as { changed: boolean; skill: string };
    if (claudeOut.skill !== join(cfg, "skills", "mh", "SKILL.md")) {
      throw new Error(`unexpected Claude install path: ${claudeOut.skill}`);
    }
    const claudeLen = assertSkillBody(claudeOut.skill);

    const codex = spawnSync(bin, ["init", "--codex", "--json"], {
      cwd: cfg,
      env: { ...process.env, CODEX_HOME: cfg },
      encoding: "utf8",
    });
    if (codex.error) throw codex.error;
    if (codex.status !== 0) {
      throw new Error(`init --codex exited ${codex.status}: ${codex.stderr || codex.stdout}`);
    }
    const codexOut = JSON.parse(codex.stdout.trim()) as {
      changed: boolean;
      skill: string;
      metadata: string;
    };
    if (codexOut.skill !== join(cfg, "skills", "mh", "SKILL.md")) {
      throw new Error(`unexpected Codex install path: ${codexOut.skill}`);
    }
    if (codexOut.metadata !== join(cfg, "skills", "mh", "agents", "openai.yaml")) {
      throw new Error(`unexpected Codex metadata path: ${codexOut.metadata}`);
    }
    const codexLen = assertSkillBody(codexOut.skill);
    const metadata = readFileSync(codexOut.metadata, "utf8");
    if (!metadata.includes("Use $mh to store, recall, search, and edit durable working memory")) {
      throw new Error("installed Codex metadata is missing the expected default_prompt");
    }

    console.log(
      `✅ skill smoke ok (${(Math.max(claudeLen, codexLen) / 1024).toFixed(1)}KB) — ${binaryPath}`,
    );
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const binaryPath = process.argv[2];
  if (!binaryPath) {
    console.error("usage: bun run scripts/smoke-skill.ts <path-to-binary>");
    process.exit(1);
  }
  await smokeSkill(binaryPath);
}
