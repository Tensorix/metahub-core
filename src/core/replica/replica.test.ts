import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExpoDriver, type ExpoDatabase } from "../../../apps/mobile/src/lib/replica/expo-driver.ts";
import { initSchema, migrateRecords } from "../schema-init.ts";
import { createReplicaService } from "./service.ts";
import { createReplicaSync } from "./sync.ts";
import { changesAfterSeq, ingestDetailed, emit } from "../crdt.ts";
import { createDatabase } from "../databases.ts";
import { createDocument } from "../documents.ts";
import { getNodeId } from "../node.ts";
import { generateMasterKey, toB64 } from "../sync/e2ee.ts";
import { publishSnapshot, syncWithStorage, type S3Config, type StorageClient } from "../sync/storage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function native(path = ":memory:", id = crypto.randomUUID()) {
  const sqlite = new Database(path);
  const adapter: ExpoDatabase = {
    execSync: sql => sqlite.exec(sql),
    getFirstSync: <T>(sql: string, params: any[]) => sqlite.query(sql).get(...params) as T | null,
    getAllSync: <T>(sql: string, params: any[]) => sqlite.query(sql).all(...params) as T[],
    runSync: (sql, params) => sqlite.query(sql).run(...params),
    closeSync: () => sqlite.close(),
  };
  const db = new ExpoDriver(adapter);
  initSchema(db);
  db.query("INSERT OR IGNORE INTO meta (key,value) VALUES ('node_id',?)").run(id);
  const service = createReplicaService(db);
  cleanups.push(() => { service.dispose(); try { db.close(); } catch {} });
  return { db, service, sqlite };
}
const target = { kind: "http" as const, url: "https://peer.example", token: "private-bearer" };
function peerFetch(remote: Database, bodies: any[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    bodies.push(request);
    ingestDetailed(remote, request.changes);
    const pull = changesAfterSeq(remote, request.since, { limit: request.limit });
    return Response.json({ node_id: getNodeId(remote), changes: pull.changes, cursor: pull.cursor });
  }) as typeof fetch;
}

test("Expo driver preserves binding, nested rollback, synchronous ownership, and failed CRUD atomicity", () => {
  const { db, service } = native();
  db.exec("CREATE TABLE contract (value BLOB)");
  db.query("INSERT INTO contract VALUES (?)").run(new Uint8Array([0, 255]));
  expect((db.query("SELECT value FROM contract").get() as any).value).toEqual(new Uint8Array([0, 255]));
  expect(() => db.query("INSERT INTO contract VALUES (?)").run(2n ** 60n)).toThrow(RangeError);
  db.transaction(() => {
    db.query("INSERT INTO contract VALUES (?)").run(true);
    expect(() => db.transaction(() => { db.query("INSERT INTO contract VALUES (?)").run(9); throw Error("inner"); })()).toThrow("inner");
    db.query("INSERT INTO contract VALUES (?)").run(false);
  })();
  expect(db.query("SELECT count(*) AS n FROM contract").get()).toEqual({ n: 3 });
  expect(() => db.transaction(() => Promise.resolve())()).toThrow("synchronous");
  const database = service.dispatch("createDatabase", [{ name: "Atomic records" }]);
  service.dispatch("addProperty", [database.id, { name: "Number", type: "number" }]);
  const before = changesAfterSeq(db, 0).changes.length;
  expect(() => service.dispatch("createRecord", [database.id, { Number: "invalid" }])).toThrow();
  expect(changesAfterSeq(db, 0).changes.length).toBe(before);
  expect(service.dispatch("listRecords", [database.id])).toHaveLength(0);
});

test("native replica persists CRUD and recovery drafts across close and reopen with a stable node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-native-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "workspace.db");
  const first = native(path, "stable-phone");
  const database = await first.service.client.createDatabase({ name: "Offline" });
  const property = await first.service.client.addProperty(database.id, { name: "Title", type: "text" });
  const record = await first.service.client.createRecord(database.id, { Title: "Saved without a server" });
  const document = await first.service.client.createDocument({ title: "Notes", body: "Durable body" });
  first.service.drafts.checkpointDocument(document.id, { revision: 2, title: "Newer", body: "draft", version: document.version });
  first.service.drafts.checkpointDocument(document.id, { revision: 1, title: "Older", body: "stale", version: null });
  first.service.drafts.acknowledgeDocument(document.id, 1);
  first.service.drafts.checkpointField(record.id, property.id, { value: "new", status: "pending" });
  first.service.drafts.acknowledgeField(record.id, property.id, "old");
  first.service.dispose(); first.db.close();
  const next = native(path, "ignored-new-node");
  expect(getNodeId(next.db)).toBe("stable-phone");
  expect((await next.service.client.getRecord(record.id)).values.Title).toBe("Saved without a server");
  expect((await next.service.client.getDocument(document.id)).body).toBe("Durable body");
  expect(next.service.drafts.readDocument(document.id)?.title).toBe("Newer");
  expect(next.service.drafts.readFields(record.id)[property.id]?.value).toBe("new");
  await next.service.client.deleteRecord(record.id);
  expect(await next.service.client.listRecords(database.id)).toHaveLength(0);
});

test("hydration uses bounded pages, yields to local edits, and resumes durably only after exhaustion", async () => {
  const { db, service } = native();
  const remote = new Database(":memory:"); initSchema(remote); cleanups.push(() => remote.close());
  for (let i = 0; i < 40; i++) createDocument(remote, { title: `Remote ${i}`, body: "body" });
  const bodies: any[] = [];
  let yielded = false;
  const sync = createReplicaSync(db, { targets: () => [{ ...target, fetch: peerFetch(remote, bodies) }], pagesPerRound: 1 });
  await sync.syncNow();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].limit).toBe(200);
  expect(bodies[0].changes.length).toBeLessThanOrEqual(200);
  expect(sync.status.hydrationReady).toBe(false);
  expect(sync.status.pendingPull).toBe(true);
  setTimeout(() => { yielded = true; service.dispatch("createDatabase", [{ name: "Write during hydration" }]); }, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  while (!sync.status.hydrationReady) await sync.syncNow();
  expect(yielded).toBe(true);
  expect(sync.status.pendingPush).toBe(0);
  expect(sync.status.pendingPull).toBe(false);
  expect(service.commands.listDocuments()).toHaveLength(40);
  expect(db.query("SELECT token,config FROM peers").get()).toEqual({ token: null, config: null });
  await sync.stop();
  const reopened = createReplicaSync(db, { targets: () => [target] });
  expect(reopened.status.hydrationReady).toBe(true);
  await reopened.stop();
});

test("bounded draining yields between pages and unacknowledged writes remain visible offline", async () => {
  const { db, service } = native();
  const statuses: boolean[] = [];
  let calls = 0;
  const sync = createReplicaSync(db, {
    targets: () => [target], pagesPerRound: 2,
    onStatus: status => statuses.push(status.hydrationReady),
    syncTarget: async () => ({ pushed: 0, pulled: 0, received: ++calls <= 2 ? 200 : 0 }),
  });
  let yielded = false; setTimeout(() => { yielded = true; }, 0);
  await sync.syncNow();
  expect(calls).toBe(2); expect(yielded).toBe(true);
  expect(sync.status.hydrationReady).toBe(false);
  await sync.syncNow(); expect(sync.status.hydrationReady).toBe(true);
  const database = service.commands.createDatabase({ name: "Offline pending" });
  sync.requestSync(); expect(sync.status.pendingPush).toBeGreaterThan(0);
  await sync.stop();
  expect(service.commands.listDatabases().some(row => row.id === database.id)).toBe(true);
});

test("stop cancels unresponsive HTTP, permits close, and rejects late stale writes", async () => {
  const { db, service } = native();
  const remote = new Database(":memory:"); initSchema(remote); cleanups.push(() => remote.close());
  createDatabase(remote, { name: "Late remote" });
  const changes = changesAfterSeq(remote, 0);
  let release!: (value: Response) => void;
  const stalled = new Promise<Response>(resolve => { release = resolve; });
  const sync = createReplicaSync(db, { targets: () => [{ ...target, fetch: (() => stalled) as typeof fetch }] });
  const running = sync.syncNow();
  await sync.stop();
  await running;
  expect(sync.status.connected).toBe(false);
  expect(service.commands.listDatabases()).toHaveLength(0);
  db.close();
  release(Response.json({ node_id: "remote", changes: changes.changes, cursor: changes.cursor }));
  await new Promise(resolve => setTimeout(resolve, 5));
});

test("two peers converge native offline edits, deletes, and document conflicts after transport failure", async () => {
  const a = native(":memory:", "phone-a"); const b = native(":memory:", "phone-b");
  const server = new Database(":memory:"); initSchema(server); cleanups.push(() => server.close());
  let online = false;
  const connection = (async (...args: Parameters<typeof fetch>) => { if (!online) throw Error("offline"); return peerFetch(server)(...args); }) as typeof fetch;
  const sa = createReplicaSync(a.db, { targets: () => [{ ...target, fetch: connection }] });
  const sb = createReplicaSync(b.db, { targets: () => [{ ...target, fetch: connection }] });
  const document = a.service.commands.createDocument({ title: "Shared", body: "Initial" });
  const database = a.service.commands.createDatabase({ name: "Delete me" });
  await sa.syncNow(); expect(sa.status.error).toBe("offline"); expect(sa.status.hydrationReady).toBe(false);
  online = true;
  await sa.syncNow(); await sb.syncNow();
  a.service.commands.updateDocument(document.id, { body: "A offline edit" });
  b.service.commands.updateDocument(document.id, { title: "B offline title" });
  a.service.commands.deleteDatabase(database.id);
  await sa.syncNow(); await sb.syncNow(); await sa.syncNow();
  expect(a.service.commands.getDocument(document.id)).toEqual(b.service.commands.getDocument(document.id));
  expect(a.service.commands.getDocument(document.id).title).toBe("B offline title");
  expect(a.service.commands.getDocument(document.id).body).toBe("A offline edit");
  expect(b.service.commands.listDatabases()).toHaveLength(0);
  await sa.stop(); await sb.stop();
});

const config: S3Config = { endpoint: "https://s3.test", region: "auto", bucket: "bucket", prefix: "replica", accessKeyId: "private-id", secretAccessKey: "private-secret", encrypt: false };
function bucket(): StorageClient {
  const store = new Map<string, Uint8Array>();
  return {
    async list(prefix, after) { return [...store.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort().map(key => ({ key })); },
    async get(key) { return store.get(key) ?? null; },
    async put(key, body) { store.set(key, body); }, async del(key) { store.delete(key); },
  };
}
test("native storage bounds pushes and yields snapshot/segment ingestion before cursor acknowledgement", async () => {
  const a = native(":memory:", "storage-a"); const b = native(":memory:", "storage-b");
  const url = "s3://s3.test/bucket/replica"; const client = bucket();
  for (const replica of [a, b]) replica.db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  for (let i = 0; i < 205; i++) emit(a.db, "databases", `db-${i}`, "name", `Database ${i}`);
  const first = await syncWithStorage(a.db, url, client, config, { pushLimit: 200 });
  expect(first.pushed).toBe(200); expect(first.pendingPush).toBe(true);
  const second = await syncWithStorage(a.db, url, client, config, { pushLimit: 200 });
  expect(second.pushed).toBe(5); expect(second.pendingPush).toBe(false);
  let yielded = false; setTimeout(() => { yielded = true; }, 0);
  await syncWithStorage(b.db, url, client, config, { ingestBatchSize: 10 });
  expect(yielded).toBe(true); expect(b.service.commands.listDatabases()).toHaveLength(205);
});

test("storage cancellation unblocks stop without acknowledging an unfinished upload", async () => {
  const { db, service } = native(":memory:", "storage-cancel");
  const url = "s3://s3.test/bucket/replica";
  db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  service.commands.createDatabase({ name: "Pending bucket write" });
  const abort = new AbortController();
  let complete!: () => void;
  const stalled = new Promise<void>(resolve => { complete = resolve; });
  const storage = bucket();
  storage.put = async () => stalled;
  const syncing = syncWithStorage(db, url, storage, config, { signal: abort.signal, pushLimit: 200, ingestBatchSize: 200 });
  abort.abort(new Error("workspace closed"));
  await expect(syncing).rejects.toThrow("workspace closed");
  expect(db.query("SELECT push_cursor FROM peers WHERE url=?").get(url)).toEqual({ push_cursor: 0 });
  db.close();
  complete();
  await new Promise(resolve => setTimeout(resolve, 5));
});

test("hydration waits for every target and bucket credentials stay outside SQLite", async () => {
  const { db } = native();
  const storageTarget = { kind: "s3" as const, config: { ...config, masterKey: "private-master-key" } };
  let bucketOnline = false;
  const sync = createReplicaSync(db, {
    targets: () => [target, storageTarget],
    syncTarget: async current => {
      if (current.kind === "s3" && !bucketOnline) throw Error("bucket offline");
      return { pushed: 0, pulled: 0, received: 0 };
    },
  });
  await sync.syncNow();
  expect(sync.status.connected).toBe(true);
  expect(sync.status.hydrationReady).toBe(false);
  expect(sync.status.pendingPull).toBe(true);
  expect(sync.status.error).toBe("bucket offline");
  bucketOnline = true;
  await sync.syncNow();
  expect(sync.status.hydrationReady).toBe(true);
  const peers = db.query("SELECT url,token,config FROM peers").all() as any[];
  expect(peers).toHaveLength(2);
  for (const peer of peers) { expect(peer.token).toBeNull(); expect(peer.config).toBeNull(); }
  expect(JSON.stringify(peers)).not.toContain("private-");
  await sync.stop();
});

test("revoked sync credentials surface reauthorization and preserve pending local edits", async () => {
  const { db, service } = native();
  service.commands.createDatabase({ name: "Keep until reauthorized" });
  let authorized = false;
  const remote = new Database(":memory:"); initSchema(remote); cleanups.push(() => remote.close());
  const transport = (async (...args: Parameters<typeof fetch>) => authorized
    ? peerFetch(remote)(...args)
    : new Response(null, { status: 401 })) as typeof fetch;
  const sync = createReplicaSync(db, { targets: () => [{ ...target, fetch: transport }] });
  await sync.syncNow();
  expect(sync.status.authInvalid).toBe(true);
  expect(sync.status.connected).toBe(false);
  expect(sync.status.pendingPush).toBeGreaterThan(0);
  expect(sync.status.hydrationReady).toBe(false);
  expect(db.query("SELECT push_cursor FROM peers").get()).toEqual({ push_cursor: 0 });
  authorized = true;
  await sync.syncNow();
  expect(sync.status.authInvalid).toBe(false);
  expect(sync.status.pendingPush).toBe(0);
  expect(sync.status.hydrationReady).toBe(true);
  await sync.stop();
});

test("bucket pull budget resumes snapshot plus tail without premature hydration exhaustion", async () => {
  const a = native(":memory:", "budget-a"), b = native(":memory:", "budget-b");
  const url = "s3://s3.test/bucket/replica", store = bucket();
  for (const replica of [a, b]) replica.db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  emit(a.db, "databases", "baseline", "name", "Snapshot baseline");
  await syncWithStorage(a.db, url, store, config);
  await publishSnapshot(a.db, store, config);
  for (let i = 0; i < 2; i++) {
    emit(a.db, "databases", `tail-${i}`, "name", `Tail ${i}`);
    await syncWithStorage(a.db, url, store, config);
  }
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await syncWithStorage(b.db, url, store, config, { pullObjectLimit: 1 }));
  expect(results.map(r => r.pulled)).toEqual([1, 1, 1]);
  expect(results.map(r => r.pendingPull)).toEqual([true, true, false]);
  expect(b.service.commands.listDatabases()).toHaveLength(3);
  expect((await syncWithStorage(b.db, url, store, config, { pullObjectLimit: 1 })).pulled).toBe(0);
});

test("interrupted snapshot ingestion survives reopen and replays only uncommitted work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-hydration-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = native(":memory:", "snapshot-author"), b = native(join(dir, "workspace.db"), "snapshot-reader");
  const url = "s3://s3.test/bucket/replica", store = bucket();
  b.db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  for (let i = 0; i < 12; i++) emit(a.db, "databases", `snapshot-${i}`, "name", `Database ${i}`);
  await publishSnapshot(a.db, store, config);
  const abort = new AbortController();
  await expect(syncWithStorage(b.db, url, store, config, {
    ingestBatchSize: 4, signal: abort.signal,
    onIngest: () => abort.abort(new Error("process stopped")),
  })).rejects.toThrow("process stopped");
  expect(b.service.commands.listDatabases()).toHaveLength(4);
  expect(b.db.query("SELECT * FROM storage_cursors").all()).toHaveLength(0);
  b.service.dispose(); b.db.close();
  const reopened = native(join(dir, "workspace.db"));
  expect(getNodeId(reopened.db)).toBe("snapshot-reader");
  const recovered = await syncWithStorage(reopened.db, url, store, config, { ingestBatchSize: 4, pullObjectLimit: 1 });
  expect(recovered.pulled).toBe(8);
  expect(recovered.pendingPull).toBe(false);
  expect(reopened.service.commands.listDatabases()).toHaveLength(12);
  expect(changesAfterSeq(reopened.db, 0).changes).toHaveLength(12);
});

test("three encrypted bucket replicas recover lost upload acknowledgments and corrupt segments then converge", async () => {
  const replicas = [native(":memory:", "encrypted-a"), native(":memory:", "encrypted-b"), native(":memory:", "encrypted-c")];
  const [a, b, c] = replicas as [ReturnType<typeof native>, ReturnType<typeof native>, ReturnType<typeof native>];
  const encrypted = { ...config, encrypt: true, masterKey: toB64(generateMasterKey()) };
  const url = "s3://s3.test/bucket/replica", store = bucket();
  for (const r of replicas) r.db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  const document = a.service.commands.createDocument({ title: "Shared", body: "Baseline" });
  const database = a.service.commands.createDatabase({ name: "Concurrent delete" });
  for (const r of replicas) await syncWithStorage(r.db, url, store, encrypted);
  a.service.commands.updateDocument(document.id, { body: "A body after partition" });
  b.service.commands.updateDocument(document.id, { title: "B title after partition" });
  c.service.commands.deleteDatabase(database.id);
  const previous = a.db.query("SELECT push_cursor FROM peers").get();
  let lose = true;
  const lossy = { ...store, put: async (...args: Parameters<StorageClient["put"]>) => {
    await store.put(...args);
    if (lose && args[0].endsWith(".seg")) { lose = false; throw Error("upload response lost"); }
  } };
  await expect(syncWithStorage(a.db, url, lossy, encrypted)).rejects.toThrow("upload response lost");
  expect(a.db.query("SELECT push_cursor FROM peers").get()).toEqual(previous);
  await syncWithStorage(a.db, url, store, encrypted);
  await syncWithStorage(b.db, url, store, encrypted);
  const segment = (await store.list("replica/spaces/default/oplog/encrypted-b/")).find(o => o.key.endsWith(".seg"))!.key;
  const original = (await store.get(segment))!;
  const corrupt = original.slice(); corrupt[corrupt.length - 1]! ^= 1;
  await store.put(segment, corrupt);
  await expect(syncWithStorage(c.db, url, store, encrypted)).rejects.toThrow();
  expect(c.db.query("SELECT last_key FROM storage_cursors WHERE node_id='encrypted-b'").get()).toBeNull();
  await store.put(segment, original);
  for (let round = 0; round < 2; round++) for (const r of replicas) await syncWithStorage(r.db, url, store, encrypted, { pullObjectLimit: 1, ingestBatchSize: 2 });
  const expected = a.service.commands.getDocument(document.id);
  expect(expected.body).toBe("A body after partition");
  expect(expected.title).toBe("B title after partition");
  for (const r of replicas) {
    expect(r.service.commands.getDocument(document.id)).toEqual(expected);
    expect(r.service.commands.listDatabases()).toHaveLength(0);
    expect((await syncWithStorage(r.db, url, store, encrypted)).pulled).toBe(0);
  }
});

test("a listed segment disappearing never acknowledges later segments past the gap", async () => {
  const a = native(":memory:", "missing-a"), b = native(":memory:", "missing-b");
  const url = "s3://s3.test/bucket/replica", store = bucket();
  for (const r of [a, b]) r.db.query("INSERT INTO peers (url,kind) VALUES (?,'s3')").run(url);
  for (let i = 0; i < 2; i++) { emit(a.db, "databases", `missing-${i}`, "name", String(i)); await syncWithStorage(a.db, url, store, config); }
  const first = (await store.list("replica/spaces/default/oplog/missing-a/")).find(o => o.key.endsWith(".seg"))!.key;
  const missing = { ...store, get: async (key: string) => key === first ? null : store.get(key) };
  await expect(syncWithStorage(b.db, url, missing, config)).rejects.toThrow("segment disappeared");
  expect(b.db.query("SELECT * FROM storage_cursors").all()).toHaveLength(0);
  await syncWithStorage(b.db, url, store, config);
  expect(b.service.commands.listDatabases()).toHaveLength(2);
});

test("failed native ingestion leaves HTTP cursors and local data intact for retry", async () => {
  const { db, service } = native();
  const remote = new Database(":memory:"); initSchema(remote); cleanups.push(() => remote.close());
  const local = service.commands.createDatabase({ name: "Local survives storage failure" });
  createDatabase(remote, { name: "Remote pending retry" });
  db.exec("CREATE TRIGGER simulate_disk_full BEFORE INSERT ON crdt_changes BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  const sync = createReplicaSync(db, { targets: () => [{ ...target, fetch: peerFetch(remote) }] });
  await sync.syncNow();
  expect(sync.status.error).toContain("database or disk is full");
  expect(sync.status.pendingPush).toBeGreaterThan(0);
  expect(service.commands.listDatabases().map(r => r.id)).toEqual([local.id]);
  expect(db.query("SELECT pull_cursor,push_cursor FROM peers").get()).toEqual({ pull_cursor: 0, push_cursor: 0 });
  db.exec("DROP TRIGGER simulate_disk_full");
  await sync.syncNow();
  expect(sync.status.error).toBeNull();
  expect(sync.status.pendingPush).toBe(0);
  expect(service.commands.listDatabases()).toHaveLength(2);
  await sync.stop();
});

test("failed legacy record migration rolls back its data rewrite and source-table drop before retry", () => {
  const { db } = native();
  db.exec("DROP TABLE records");
  db.exec("CREATE TABLE records (id TEXT PRIMARY KEY, database_id TEXT, created_hlc TEXT, __deleted INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE record_values (record_id TEXT, property_id TEXT, value TEXT)");
  db.query("INSERT INTO records (id,database_id,created_hlc) VALUES (?,?,?)").run("legacy-record", "legacy-db", "000000000000001-0000-old");
  db.query("INSERT INTO record_values VALUES (?,?,?)").run("legacy-record", "title", '"Recover me"');
  // Fail after UPDATE and DROP ran, during the transaction's order-key backfill.
  db.exec("CREATE TRIGGER migration_disk_full BEFORE INSERT ON crdt_changes BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  expect(() => migrateRecords(db)).toThrow("database or disk is full");
  expect(db.query("SELECT value FROM record_values").all()).toEqual([{ value: '"Recover me"' }]);
  expect(db.query("SELECT data,order_key FROM records").get()).toEqual({ data: "{}", order_key: null });
  db.exec("DROP TRIGGER migration_disk_full");
  migrateRecords(db);
  expect(db.query("SELECT data FROM records").get()).toEqual({ data: '{"title":"Recover me"}' });
  expect((db.query("SELECT order_key FROM records").get() as { order_key: string }).order_key).toBeString();
  expect(db.query("SELECT name FROM sqlite_master WHERE name='record_values'").get()).toBeNull();
  migrateRecords(db);
  expect(db.query("SELECT data FROM records").get()).toEqual({ data: '{"title":"Recover me"}' });
});

test("unclassified native failures roll back ingestion while known malformed JSON remains isolated", () => {
  const source = native(":memory:", "failure-source"), destination = native();
  const good = emit(source.db, "databases", "good", "name", "Keep on retry");
  const bad = emit(source.db, "databases", "reject", "name", "Valid remote value");
  destination.db.exec("CREATE TRIGGER native_wrapped_failure BEFORE INSERT ON crdt_changes WHEN NEW.row_id='reject' BEGIN SELECT RAISE(ABORT, 'Call to function NativeStatement.executeSync rejected: SQLITE_ABORT'); END");
  expect(() => ingestDetailed(destination.db, [good, bad])).toThrow("NativeStatement.executeSync");
  expect(changesAfterSeq(destination.db, 0).changes).toHaveLength(0);
  expect(destination.service.commands.listDatabases()).toHaveLength(0);
  destination.db.exec("DROP TRIGGER native_wrapped_failure");
  const malformed = { ...bad, value: "not-json{" };
  expect(ingestDetailed(destination.db, [good, malformed]).received).toBe(1);
  expect(changesAfterSeq(destination.db, 0).changes).toHaveLength(1);
  expect(ingestDetailed(destination.db, [bad]).received).toBe(1);
  expect(destination.service.commands.listDatabases()).toHaveLength(2);
});
