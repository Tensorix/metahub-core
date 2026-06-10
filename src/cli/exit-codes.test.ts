import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI's exit-code/error-code contract (SKILL.md "you almost always get
// JSON"): agents dispatch on `code` + exit status, so these are load-bearing.

const CLI = new URL("./index.ts", import.meta.url).pathname;
let home: string;

function mh(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--json"], {
    env: { ...process.env, METAHUB_HOME: home },
  });
  const line = r.stdout.toString().trim();
  return { exit: r.exitCode, out: line ? JSON.parse(line) : null };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mh-exit-"));
  expect(mh("init").exit).toBe(0);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("success exits 0 with effect evidence", () => {
  const r = mh("doc", "create", "--title", "Contract", "--body", "hello world");
  expect(r.exit).toBe(0);
  expect(r.out.id).toStartWith("doc_");
});

test("not_found → exit 3 + code field", () => {
  const r = mh("doc", "get", "no-such-doc-xyz");
  expect(r.exit).toBe(3);
  expect(r.out.code).toBe("not_found");
  expect(r.out.error).toContain("no such document");
});

test("ambiguous ref → exit 4 + candidate list", () => {
  mh("doc", "create", "--title", "Twin", "--body", "a");
  mh("doc", "create", "--title", "Twin", "--body", "b");
  const r = mh("doc", "get", "Twin");
  expect(r.exit).toBe(4);
  expect(r.out.code).toBe("ambiguous");
});

test("stale --if-match → exit 5", () => {
  const r = mh("doc", "edit", "Contract", "--old", "hello", "--new", "hi", "--if-match", "bogus-version");
  expect(r.exit).toBe(5);
  expect(r.out.code).toBe("stale");
});

test("anchor not found → exit 2 invalid_input", () => {
  const r = mh("doc", "edit", "Contract", "--old", "NO-SUCH-ANCHOR", "--new", "x");
  expect(r.exit).toBe(2);
  expect(r.out.code).toBe("invalid_input");
});
