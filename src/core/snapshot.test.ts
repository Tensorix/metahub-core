import { test, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMetahub } from "./db.ts";
import { createDatabase, listDatabases } from "./databases.ts";
import { createDocument, listDocuments } from "./documents.ts";
import { putBlob, getBlob } from "./cache.ts";
import {
  createSnapshot,
  writeSnapshot,
  readSnapshot,
  restoreSnapshot,
} from "./snapshot.ts";

const ORIGINAL_HOME = process.env.METAHUB_HOME;
const homes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mh-snap-"));
  homes.push(dir);
  process.env.METAHUB_HOME = dir;
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
});

test("snapshot round-trips through a gzip package file", async () => {
  const home = freshHome();
  const db = openMetahub();
  createDatabase(db, { name: "Tasks" });
  createDocument(db, { title: "Hello", body: "world" });
  const blob = await putBlob("attachment-bytes");

  const pkg = await createSnapshot(db);
  expect(pkg.counts.changes).toBeGreaterThan(0);
  expect(pkg.counts.blobs).toBe(1);
  expect(pkg.blobs[blob.hash]).toBeDefined();

  const path = join(home, "out.mhpack");
  const info = await writeSnapshot(pkg, path);
  expect(info.bytes).toBeGreaterThan(0);

  const read = await readSnapshot(path);
  expect(read.counts).toEqual(pkg.counts);
  expect(read.changes.length).toBe(pkg.changes.length);
});

test("merge restores data and blobs into a fresh hub", async () => {
  const homeA = freshHome();
  const a = openMetahub();
  createDatabase(a, { name: "Tasks" });
  createDocument(a, { title: "Hello", body: "world" });
  const blob = await putBlob("hello bytes");
  const path = join(homeA, "a.mhpack");
  await writeSnapshot(await createSnapshot(a), path);

  freshHome();
  const b = openMetahub();
  const res = await restoreSnapshot(b, await readSnapshot(path));

  expect(res.mode).toBe("merge");
  expect(listDatabases(b).map((d) => d.name)).toContain("Tasks");
  expect(listDocuments(b).map((d) => d.title)).toContain("Hello");
  const restored = await getBlob(blob.hash);
  expect(restored).not.toBeNull();
  expect(new TextDecoder().decode(restored!)).toBe("hello bytes");
});

test("reset replaces local data and preserves package identity", async () => {
  const homeA = freshHome();
  const a = openMetahub();
  createDatabase(a, { name: "FromA" });
  const path = join(homeA, "a.mhpack");
  await writeSnapshot(await createSnapshot(a), path);
  const pkg = await readSnapshot(path);

  freshHome();
  const b = openMetahub();
  createDatabase(b, { name: "OnlyInB" });

  const res = await restoreSnapshot(b, pkg, { reset: true, force: true });

  expect(res.mode).toBe("reset");
  expect(res.safetyPath).toBeDefined();
  expect(existsSync(res.safetyPath!)).toBe(true);

  const names = listDatabases(b).map((d) => d.name);
  expect(names).toContain("FromA");
  expect(names).not.toContain("OnlyInB");

  const nodeId = (
    b.query("SELECT value FROM meta WHERE key = 'node_id'").get() as {
      value: string;
    }
  ).value;
  expect(pkg.meta.node_id).toBeTruthy();
  expect(nodeId).toBe(pkg.meta.node_id!);
});

test("reset without force is refused", async () => {
  const homeA = freshHome();
  const a = openMetahub();
  createDatabase(a, { name: "X" });
  const path = join(homeA, "a.mhpack");
  await writeSnapshot(await createSnapshot(a), path);
  const pkg = await readSnapshot(path);

  freshHome();
  const b = openMetahub();
  expect(restoreSnapshot(b, pkg, { reset: true })).rejects.toThrow(/--force/);
});
