import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldClaudeSkill, scaffoldCodexSkill } from "./agent-skill.ts";

// `mh init --claude` / `mh init --codex` embed the repo-root SKILL.md as text
// and install it under the agent config dir. These guard the *source/bundler*
// path: that the text import resolves, content is intact, Codex metadata is
// written, and re-running is an honest no-op. (The compiled-binary embed is
// guarded separately by scripts/smoke-skill.ts.)

let claudeCfg: string;
let codexHome: string;
const prevClaude = process.env.CLAUDE_CONFIG_DIR;
const prevCodex = process.env.CODEX_HOME;

beforeAll(() => {
  claudeCfg = mkdtempSync(join(tmpdir(), "mh-claude-"));
  codexHome = mkdtempSync(join(tmpdir(), "mh-codex-"));
  process.env.CLAUDE_CONFIG_DIR = claudeCfg;
  process.env.CODEX_HOME = codexHome;
});
afterAll(() => {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  if (prevCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodex;
  rmSync(claudeCfg, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

test("installs the Claude Code /mh skill with intact embedded content", async () => {
  const r = await scaffoldClaudeSkill();
  expect(r.changed).toBe(true);
  expect(r.path).toBe(join(claudeCfg, "skills", "mh", "SKILL.md"));

  const body = await Bun.file(r.path).text();
  expect(body.length).toBeGreaterThan(0);
  expect(body.startsWith("---\n")).toBe(true);
  // Frontmatter: the dir name yields /mh, but the embed must carry the tuned name.
  expect(body).toContain("name: mh");
  // A stable body phrase proves it's the real guide, not a stub.
  expect(body).toContain("durable, syncable working memory");
});

test("re-running the Claude Code install is an idempotent no-op", async () => {
  const again = await scaffoldClaudeSkill();
  expect(again.changed).toBe(false);
});

test("installs the Codex $mh skill and UI metadata", async () => {
  const r = await scaffoldCodexSkill();
  expect(r.changed).toBe(true);
  expect(r.path).toBe(join(codexHome, "skills", "mh", "SKILL.md"));
  expect(r.metadataPath).toBe(join(codexHome, "skills", "mh", "agents", "openai.yaml"));

  const body = await Bun.file(r.path).text();
  expect(body.length).toBeGreaterThan(0);
  expect(body.startsWith("---\n")).toBe(true);
  expect(body).toContain("name: mh");
  expect(body).toContain("durable, syncable working memory");

  const metadata = await Bun.file(r.metadataPath).text();
  expect(metadata).toContain('display_name: "Metahub"');
  expect(metadata).toContain('short_description: "Use mh for durable agent memory"');
  expect(metadata).toContain("Use $mh to store, recall, search, and edit durable working memory");
});

test("re-running the Codex install is an idempotent no-op", async () => {
  const again = await scaffoldCodexSkill();
  expect(again.changed).toBe(false);
});
