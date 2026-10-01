import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Several agent processes writing one hub at once (CLI + CLI, CLI + server
// sidecar): every command either lands whole or fails with code busy, never
// half-written rows, orphan blocks or duplicate HLCs.

const CLI = new URL("./index.ts", import.meta.url).pathname;
const N = 16;
let home: string;

function mhSync(...args: string[]) {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--json"], {
    env: { ...process.env, METAHUB_HOME: home },
  });
  return JSON.parse(r.stdout.toString().trim());
}

async function mh(...args: string[]): Promise<{ exit: number; out: string }> {
  const p = Bun.spawn(["bun", CLI, ...args, "--json"], {
    env: { ...process.env, METAHUB_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  return { exit: await p.exited, out: out.trim() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mh-conc-"));
  mhSync("db", "create", "tasks");
  mhSync("prop", "add", "Title", "--type", "text", "--db", "tasks");
  mhSync("prop", "add", "Note", "--type", "text", "--db", "tasks");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test(`${N} record creates + ${N} doc appends from parallel processes all land whole`, async () => {
  const doc = mhSync("doc", "create", "--title", "notes", "--body", "para one");
  const runs = await Promise.all([
    ...Array.from({ length: N }, (_, i) =>
      mh("record", "create", "tasks", "--data", JSON.stringify({ Title: `rec ${i}`, Note: `n${i}` })),
    ),
    ...Array.from({ length: N }, (_, i) => mh("doc", "append", doc.id, "--body", `appended ${i}`)),
  ]);
  const failed = runs.filter((r) => r.exit !== 0);
  expect(failed.map((r) => r.out)).toEqual([]);

  const db = new Database(join(home, "metahub.db"), { readonly: true });
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
  expect(one("SELECT COUNT(*) AS n FROM records WHERE __deleted = 0")).toBe(N);
  expect(one("SELECT COUNT(*) AS n FROM records WHERE database_id IS NULL OR order_key IS NULL")).toBe(0);
  expect(one("SELECT COUNT(*) AS n FROM doc_blocks WHERE __deleted = 0")).toBe(N + 1);
  expect(one("SELECT COUNT(*) AS n FROM doc_blocks WHERE doc_id IS NULL OR order_key IS NULL")).toBe(0);
  expect(one("SELECT COUNT(*) AS n FROM (SELECT hlc FROM crdt_changes GROUP BY hlc HAVING COUNT(*) > 1)")).toBe(0);
  const listed = mhSync("record", "list", "tasks");
  expect(listed.count).toBe(N);
});
