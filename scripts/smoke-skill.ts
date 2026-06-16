/**
 * Smoke-test that a *compiled* CLI binary carries the embedded `/mh` skill.
 *
 * `mh init --claude` writes the repo-root SKILL.md, embedded at build time as a
 * Bun text import (src/cli/claude-skill.ts). A compiled binary has no source tree,
 * so if that embed ever stops riding into the binary, `init --claude` would write
 * an empty/garbage file with no error. `bun test` can't catch this — it runs from
 * source and the import resolves off disk. We run the binary from a throwaway cwd
 * with no SKILL.md anywhere near it, which is the real proof the bytes are inside.
 *
 * Run standalone: `bun run scripts/smoke-skill.ts <path-to-binary>`
 * Or import and call smokeSkill(binaryPath) from the build script.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Throws if the binary can't install a non-empty, well-formed `/mh` skill. */
export async function smokeSkill(binaryPath: string): Promise<void> {
  // Isolated config dir AND cwd: no source tree, no sibling SKILL.md — so a pass
  // can only mean the doc is embedded in the binary itself. Resolve the binary to
  // an absolute path first, since we run it from that throwaway cwd.
  const bin = resolve(binaryPath);
  const cfg = mkdtempSync(join(tmpdir(), "mh-skill-smoke-"));
  try {
    const r = spawnSync(bin, ["init", "--claude", "--json"], {
      cwd: cfg,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      encoding: "utf8",
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error(`init --claude exited ${r.status}: ${r.stderr || r.stdout}`);
    }
    const out = JSON.parse(r.stdout.trim()) as { changed: boolean; skill: string };
    if (out.skill !== join(cfg, "skills", "mh", "SKILL.md")) {
      throw new Error(`unexpected install path: ${out.skill}`);
    }
    const body = readFileSync(out.skill, "utf8");
    if (body.length === 0) throw new Error("installed SKILL.md is empty");
    if (!body.startsWith("---\n") || !body.includes("name: mh")) {
      throw new Error("installed SKILL.md is missing the expected frontmatter");
    }
    if (!body.includes("durable, syncable working memory")) {
      throw new Error("installed SKILL.md is missing the embedded guide body");
    }
    console.log(`✅ skill smoke ok (${(body.length / 1024).toFixed(1)}KB) — ${binaryPath}`);
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
