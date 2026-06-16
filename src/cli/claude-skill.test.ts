import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldClaudeSkill } from "./claude-skill.ts";

// `mh init --claude` embeds the repo-root SKILL.md as text and installs it under
// CLAUDE_CONFIG_DIR. These guard the *source/bundler* path: that the text import
// resolves, the content is intact, and re-running is an honest no-op. (The
// compiled-binary embed is guarded separately by scripts/smoke-skill.ts.)

let cfg: string;
const prev = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
  cfg = mkdtempSync(join(tmpdir(), "mh-claude-"));
  process.env.CLAUDE_CONFIG_DIR = cfg;
});
afterAll(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
  rmSync(cfg, { recursive: true, force: true });
});

test("installs the /mh skill with intact embedded content", async () => {
  const r = await scaffoldClaudeSkill();
  expect(r.changed).toBe(true);
  expect(r.path).toBe(join(cfg, "skills", "mh", "SKILL.md"));

  const body = await Bun.file(r.path).text();
  expect(body.length).toBeGreaterThan(0);
  expect(body.startsWith("---\n")).toBe(true);
  // Frontmatter: the dir name yields /mh, but the embed must carry the tuned name.
  expect(body).toContain("name: mh");
  // A stable body phrase proves it's the real guide, not a stub.
  expect(body).toContain("durable, syncable working memory");
});

test("re-running is an idempotent no-op", async () => {
  const again = await scaffoldClaudeSkill();
  expect(again.changed).toBe(false);
});
