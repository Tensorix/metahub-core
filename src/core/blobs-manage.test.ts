import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "./schema-init.ts";
import { putBlob } from "./cache.ts";
import { recordBlob, setAnchored, setPinned, cachedBlobs } from "./blobs-core.ts";
import { clearBlobs, deleteOrphanBlobs } from "./blobs.ts";

// Each test gets its own METAHUB_HOME (= its own cache dir) so reconcileCache,
// which folds on-disk blobs into the ledger, can't see another test's bytes.
const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blob-manage-"));
  process.env.METAHUB_HOME = TMP_HOME;
});
afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function makeDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("n1");
  return db;
}

/** Put bytes on disk + a ledger row that is clearable (acquired copy, anchor-verified). */
async function putClearable(db: Database, bytes: string) {
  const b = await putBlob(bytes);
  recordBlob(db, b.hash, b.size, "image/png", 0); // pending=0 (acquired, already durable)
  setAnchored(db, b.hash, true); // a designated anchor verifiably holds it
  return b;
}

test("clearBlobs drops only the unpinned, clearable subset and skips the rest", async () => {
  const db = makeDb();
  const a = await putClearable(db, "blob-a-bytes"); // clearable → dropped
  const b = await putClearable(db, "blob-b-bytes"); // clearable but pinned → kept
  setPinned(db, b.hash, true);
  const c = await putBlob("blob-c-bytes"); // pending (sole copy) → not clearable
  recordBlob(db, c.hash, c.size, "image/png"); // pending defaults to 1

  const r = await clearBlobs(db, [a.hash, b.hash, c.hash, "deadbeef-not-in-cache"]);

  expect(r.cleared).toBe(1);
  expect(r.freedBytes).toBe(a.size);
  expect(r.skipped).toBe(3); // pinned + pending + unknown hash

  const left = new Set(cachedBlobs(db).map((x) => x.hash));
  expect(left.has(a.hash)).toBe(false); // bytes + ledger row gone
  expect(left.has(b.hash)).toBe(true); // pinned, untouched
  expect(left.has(c.hash)).toBe(true); // pending, untouched
});

test("deleteOrphanBlobs removes orphans but refuses a referenced blob", async () => {
  const db = makeDb();
  const orphan = await putBlob("orphan-bytes");
  recordBlob(db, orphan.hash, orphan.size, "image/png");
  const used = await putBlob("used-bytes");
  recordBlob(db, used.hash, used.size, "image/png");
  // A live doc block referencing `used` makes it non-orphan (referencedHashes).
  db.query("INSERT INTO doc_blocks (id, doc_id, text, order_key) VALUES (?,?,?,?)").run(
    "blk1",
    "doc1",
    `![](/blob/${used.hash}.png)`,
    "a0",
  );

  const r = await deleteOrphanBlobs(db, [orphan.hash, used.hash]);

  expect(r.removed).toBe(1);
  expect(r.freedBytes).toBe(orphan.size);

  const left = new Set(cachedBlobs(db).map((x) => x.hash));
  expect(left.has(orphan.hash)).toBe(false); // deleted
  expect(left.has(used.hash)).toBe(true); // referenced → never deleted out from under the doc
});
