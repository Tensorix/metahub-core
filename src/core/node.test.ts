import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, migrateNodes, runSchema } from "./schema-init.ts";
import { changesAfterSeq, ingest } from "./crdt.ts";
import {
  describeSelf,
  displayNodes,
  getNodeId,
  getNodeLabel,
  nodeLabelOf,
  readNodeMeta,
  setNodeLabel,
} from "./node.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}
const oplogCount = (db: Database) =>
  (db.query("SELECT count(*) AS n FROM crdt_changes").get() as { n: number }).n;

test("describeSelf writes once and is a no-op on a routine re-open", () => {
  const db = makeNode("aaaa0001");
  const first = describeSelf(db, { app: "cli", platform: "macos", form: "laptop", defaultLabel: "noahs-mbp", now: 1000 });
  expect(first).toEqual({
    node_id: "aaaa0001",
    label: "noahs-mbp",
    platform: "macos",
    form: "laptop",
    app: "cli",
    first_seen: 1000,
  });
  const n = oplogCount(db);
  expect(n).toBe(5);
  describeSelf(db, { app: "cli", platform: "macos", form: "laptop", defaultLabel: "noahs-mbp", now: 2000 });
  expect(oplogCount(db)).toBe(n); // nothing changed → nothing emitted
  expect(readNodeMeta(db, "aaaa0001")!.first_seen).toBe(1000);
  // A real change (opened by the desktop app now) emits exactly that column.
  describeSelf(db, { app: "desktop" });
  expect(oplogCount(db)).toBe(n + 1);
  expect(readNodeMeta(db, "aaaa0001")!.app).toBe("desktop");
});

test("legacy meta.node_label migrates into the roster and stays mirrored", () => {
  const db = makeNode("aaaa0002");
  db.query("INSERT INTO meta (key, value) VALUES ('node_label', '旧名字')").run();
  describeSelf(db, { app: "cli", defaultLabel: "hostname-ignored" });
  expect(getNodeLabel(db)).toBe("旧名字");
  setNodeLabel(db, "新名字");
  expect(readNodeMeta(db, "aaaa0002")!.label).toBe("新名字");
  expect((db.query("SELECT value FROM meta WHERE key = 'node_label'").get() as { value: string }).value).toBe("新名字");
  const n = oplogCount(db);
  setNodeLabel(db, " 新名字 "); // same after trim → no-op
  expect(oplogCount(db)).toBe(n);
});

test("renaming another device replicates; label chain falls back to peers.label", () => {
  const a = makeNode("aaaa000a");
  const b = makeNode("bbbb000b");
  describeSelf(b, { app: "web", platform: "ios", form: "phone", defaultLabel: "Safari · iOS" });
  // A pairs B under a local nickname before any roster row arrives.
  a.query("INSERT INTO peers (url, label, node_id) VALUES ('http://b', '配对昵称', 'bbbb000b')").run();
  expect(nodeLabelOf(a, "bbbb000b")).toBe("配对昵称");
  expect(nodeLabelOf(a, "unknown0")).toBeNull();
  // B's self-description reaches A: the synced name wins over the nickname.
  ingest(a, changesAfterSeq(b, 0).changes);
  expect(nodeLabelOf(a, "bbbb000b")).toBe("Safari · iOS");
  expect(displayNodes(a).find((n) => n.node_id === "bbbb000b")).toMatchObject({
    label: "Safari · iOS",
    platform: "ios",
    form: "phone",
    app: "web",
    self: false,
  });
  // A renames B; B sees it after sync.
  setNodeLabel(a, "Noah 的 iPhone", "bbbb000b");
  ingest(b, changesAfterSeq(a, 0).changes);
  expect(getNodeLabel(b)).toBe("Noah 的 iPhone");
  expect(getNodeId(b)).toBe("bbbb000b");
});

test("migrateNodes backfills roster rows an older binary pulled before it knew the table", () => {
  const legacy = new Database(":memory:");
  runSchema(legacy);
  legacy.query("INSERT INTO meta (key, value) VALUES ('node_id', 'cccc000c')").run();
  legacy.exec("DROP TABLE nodes");
  const ins = legacy.query(
    "INSERT INTO crdt_changes (hlc, node_id, dataset, row_id, col, value) VALUES (?, 'peer', 'nodes', 'dddd000d', ?, ?)",
  );
  ins.run("0002-dddd", "label", JSON.stringify("旧"));
  ins.run("0005-dddd", "label", JSON.stringify("新"));
  ins.run("0003-dddd", "platform", JSON.stringify("linux"));
  // Upgrade: schema creates the table, the migration replays the winners.
  initSchema(legacy);
  expect(readNodeMeta(legacy, "dddd000d")).toMatchObject({ label: "新", platform: "linux" });
  // Idempotent and incremental: a second run replays nothing new.
  legacy.query("UPDATE nodes SET label = 'tampered' WHERE id = 'dddd000d'").run();
  migrateNodes(legacy);
  expect(readNodeMeta(legacy, "dddd000d")!.label).toBe("tampered");
});
