import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initSchema } from "../schema-init.ts";
import { putBlob, deleteBlob } from "../cache.ts";
import { recordBlob } from "../blobs-core.ts";
import { routes, type Route, type RouteCtx } from "./routes.ts";

// Real on-disk bytes (putBlob writes under METAHUB_HOME/cache) so the route's
// reconcileCache keeps the rows instead of dropping them as orphans.
const ORIGINAL_HOME = process.env.METAHUB_HOME;
let TMP_HOME: string;
beforeAll(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "mh-blob-has-"));
  process.env.METAHUB_HOME = TMP_HOME;
});
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = ORIGINAL_HOME;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const hasRoute = routes.find((r: Route) => r.path === "/api/blobs/has" && r.method === "POST")!;

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

test("POST /api/blobs/has returns only the candidate hashes this node holds", async () => {
  const db = makeNode("anchor");
  const a = await putBlob("doc-image-a");
  const b = await putBlob("doc-image-b");
  recordBlob(db, a.hash, a.size, "image/png", 0);
  recordBlob(db, b.hash, b.size, "image/png", 0);
  const absent = "f".repeat(32); // never stored

  const ctx: RouteCtx = { db, node: "anchor" };
  const req = new Request("http://x/api/blobs/has", {
    method: "POST",
    body: JSON.stringify({ hashes: [a.hash, absent, b.hash] }),
  });
  const res = await hasRoute.handler(req, ctx);
  const data = (await res.json()) as { has: string[] };
  expect(new Set(data.has)).toEqual(new Set([a.hash, b.hash]));
  expect(data.has).not.toContain(absent);
});

test("POST /api/blobs/has does NOT claim a blob whose ledger row outlived its bytes", async () => {
  // Regression: the ledger only grows, so a row can survive its file after a
  // crash / compaction GC / manual cache wipe. Answering from the ledger would
  // tell a peer "I hold it" and let it drop its own last copy → total loss.
  const db = makeNode("anchor");
  const a = await putBlob("vanishing-blob");
  recordBlob(db, a.hash, a.size, "image/png", 0);
  await deleteBlob(a.hash); // bytes gone from disk, ledger row remains

  const ctx: RouteCtx = { db, node: "anchor" };
  const req = new Request("http://x/api/blobs/has", {
    method: "POST",
    body: JSON.stringify({ hashes: [a.hash] }),
  });
  const res = await hasRoute.handler(req, ctx);
  const data = (await res.json()) as { has: string[] };
  expect(data.has).toEqual([]);
});

test("POST /api/blobs/has ignores non-hash entries (no path-traversal existence oracle)", async () => {
  // `want` flows into blobExists → blobPath → join(cacheDir, h); an unchecked
  // "../" would probe arbitrary filesystem paths. They must be filtered out before
  // touching disk.
  const db = makeNode("anchor");
  const a = await putBlob("real-blob");
  recordBlob(db, a.hash, a.size, "image/png", 0);

  const ctx: RouteCtx = { db, node: "anchor" };
  const req = new Request("http://x/api/blobs/has", {
    method: "POST",
    body: JSON.stringify({ hashes: [a.hash, "../../../../etc/passwd", "Robots.txt", "NOTAHASH"] }),
  });
  const res = await hasRoute.handler(req, ctx);
  const data = (await res.json()) as { has: string[] };
  expect(data.has).toEqual([a.hash]); // only the valid hash, traversal strings dropped
});

test("POST /api/blobs/has caps the candidate list (no unbounded fan-out)", async () => {
  const db = makeNode("anchor");
  const ctx: RouteCtx = { db, node: "anchor" };
  // 5000 well-formed but absent hashes — must not error or stat all of them.
  const hashes = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(32, "0"));
  const req = new Request("http://x/api/blobs/has", {
    method: "POST",
    body: JSON.stringify({ hashes }),
  });
  const res = await hasRoute.handler(req, ctx);
  const data = (await res.json()) as { has: string[] };
  expect(data.has).toEqual([]); // none present; request handled without error
});

test("POST /api/blobs/has tolerates a missing/empty hash list", async () => {
  const db = makeNode("anchor");
  const ctx: RouteCtx = { db, node: "anchor" };
  const req = new Request("http://x/api/blobs/has", { method: "POST", body: JSON.stringify({}) });
  const res = await hasRoute.handler(req, ctx);
  const data = (await res.json()) as { has: string[] };
  expect(data.has).toEqual([]);
});
