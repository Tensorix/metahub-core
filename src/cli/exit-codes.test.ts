import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

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

test("malformed --edits JSON → exit 2 invalid_input (not a raw SyntaxError exit 1)", () => {
  const r = mh("doc", "edit", "Contract", "--edits", "not json");
  expect(r.exit).toBe(2);
  expect(r.out.code).toBe("invalid_input");
});

test("CLI public visibility records and revokes an explicit local channel", () => {
  const created = mh("site", "create", "cli-public", "--public");
  expect(created.exit).toBe(0);
  expect(created.out.visibility).toBe("public");
  const db = new Database(join(home, "metahub.db"));
  expect(
    db.query("SELECT visibility FROM sites WHERE id = ?").get(created.out.id),
  ).toEqual({ visibility: "private" });
  expect(
    db.query(
      `SELECT audience,hosting,target_ref,desired_state
       FROM site_channels WHERE site_id = ?`,
    ).get(created.out.id),
  ).toMatchObject({
    audience: "public",
    hosting: "device",
    desired_state: "active",
  });
  expect(mh(
    "site",
    "update",
    "cli-public",
    "--visibility",
    "private",
  ).exit).toBe(0);
  expect(
    db.query(
      "SELECT desired_state FROM site_channels WHERE site_id = ?",
    ).get(created.out.id),
  ).toEqual({ desired_state: "revoked" });
  db.close();
});

test("sync-all preserves per-target JSON but exits 7 when any target fails", () => {
  const db = new Database(join(home, "metahub.db"));
  db.query(
    `INSERT INTO peers
       (url,pull_cursor,push_cursor,enabled,kind)
     VALUES ('http://127.0.0.1:1',0,0,1,'http')`,
  ).run();
  db.close();
  const r = mh("sync");
  expect(r.exit).toBe(7);
  expect(Array.isArray(r.out)).toBe(true);
  expect(r.out[0]).toMatchObject({
    url: "http://127.0.0.1:1",
    ok: false,
  });
});
