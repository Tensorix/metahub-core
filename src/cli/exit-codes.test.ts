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

test("site list masks capability URLs by default; --show-links opts in", () => {
  // A private share link on a site — its /share/<slug> URL grants access and
  // must never appear in the default listing (logs, scripts, agent context).
  const site = mh("site", "create", "list-mask");
  expect(site.exit).toBe(0);
  const shared = mh("share", "create", "list-mask", "--kind", "site");
  expect(shared.exit).toBe(0);
  expect(shared.out.url).toContain("/share/");

  const plain = mh("site", "list", "--offline");
  expect(plain.exit).toBe(0);
  const row = (plain.out as Record<string, unknown>[]).find((r) => r.name === "list-mask")!;
  expect(row.access).toBe("link");
  expect(row.private_links).toMatchObject({ active: 1, expired: 0 });
  expect(row.legacy_visibility).toBe("private");
  expect(row.channels).toBeUndefined();
  expect(JSON.stringify(plain.out)).not.toContain("/share/");

  const withLinks = mh("site", "list", "--show-links", "--offline");
  expect(withLinks.exit).toBe(0);
  expect(JSON.stringify(withLinks.out)).toContain("/share/");
});

test("site access shows masked links by default and flips public/private", () => {
  mh("site", "create", "acc-demo");
  mh("share", "create", "acc-demo", "--kind", "site");

  const shown = mh("site", "access", "acc-demo", "--offline");
  expect(shown.exit).toBe(0);
  expect(shown.out.access).toBe("link");
  expect(JSON.stringify(shown.out)).not.toContain("/share/");
  expect(shown.out.channels[0].urlMasked).toMatch(/…$/);

  const withLinks = mh("site", "access", "acc-demo", "--show-links", "--offline");
  expect(JSON.stringify(withLinks.out)).toContain("/share/");

  const pub = mh("site", "access", "acc-demo", "public");
  expect(pub.exit).toBe(0);
  expect(pub.out.access).toBe("public");

  const priv = mh("site", "access", "acc-demo", "private");
  expect(priv.exit).toBe(0);
  expect(priv.out.access).toBe("private");

  const bogus = mh("site", "access", "acc-demo", "everyone");
  expect(bogus.exit).toBe(2);
  expect(bogus.out.code).toBe("invalid_input");
});

test("config show --help is real help (exit 0); unknown section fails exit 2", () => {
  const help = Bun.spawnSync(["bun", CLI, "config", "show", "--help"], {
    env: { ...process.env, METAHUB_HOME: home },
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("mh config show");

  const bogus = mh("config", "bakcup", "--help");
  expect(bogus.exit).toBe(2);
  expect(bogus.out.code).toBe("invalid_input");
  expect(bogus.out.error).toContain("bakcup");
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
