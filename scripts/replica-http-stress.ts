/** Isolated Bun/SQLite localhost transport benchmark. No user hub or credentials.
 * Run: bun scripts/replica-http-stress.ts [report.json]
 * Timings cover this host's Bun process, never Hermes/device performance. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "../src/core/schema-init.ts";
import { emit, ingestDetailed, changesAfterSeq, withChangeGroup } from "../src/core/crdt.ts";
import { createDatabase } from "../src/core/databases.ts";
import { addProperty } from "../src/core/properties.ts";
import { createDocument, updateDocument, deleteDocument, getDocument } from "../src/core/documents.ts";
import { updateRecord, deleteRecord, getRecord } from "../src/core/records.ts";
import { createReplicaSync } from "../src/core/replica/sync.ts";
import { syncWithPeer } from "../src/core/sync/client.ts";
import { routes } from "../src/core/sync/routes.ts";
import type { DbDriver, Stmt } from "../src/core/driver.ts";
import { getNodeId } from "../src/core/node.ts";

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const count = (db: DbDriver) => (db.query("SELECT count(*) AS n FROM crdt_changes").get() as { n: number }).n;
const cursors = (db: DbDriver, url: string) => db.query("SELECT pull_cursor,push_cursor FROM peers WHERE url=?").get(url);
const stable = (value: unknown) => JSON.stringify(value);
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;

/** Track SQL bridge work independently of native wall-clock claims. */
export function measuredDriver(db: Database) {
  const stats = { calls: 0, ackPrefixRows: 0, clockReads: 0, clockWrites: 0 };
  const driver: DbDriver = {
    exec: sql => db.exec(sql),
    transaction: fn => db.transaction(fn),
    query(sql) {
      const statement = db.query(sql);
      const invoke = (kind: keyof Stmt, params: any[]) => {
        stats.calls++;
        if (sql.includes("SELECT value FROM meta WHERE key = 'hlc'")) stats.clockReads++;
        if (sql.includes("VALUES ('hlc', ?)")) stats.clockWrites++;
        const result = statement[kind](...params);
        if (kind === "all" && sql.includes("SELECT rowid AS seq, hlc, node_id, dataset, row_id, col FROM crdt_changes")) stats.ackPrefixRows += (result as unknown[]).length;
        return result;
      };
      return { get: (...args) => invoke("get", args), all: (...args) => invoke("all", args) as unknown[], run: (...args) => invoke("run", args) as { changes: number } };
    },
  };
  return { driver, stats };
}

export async function runReplicaHttpStress(options: { queuedOps?: number; batchSize?: number; progress?: (phase: string) => void } = {}) {
  const queuedOps = options.queuedOps ?? 20_000;
  const batchSize = options.batchSize ?? 200;
  if (!Number.isSafeInteger(queuedOps) || queuedOps < 20_000) throw new Error("stress fixture requires at least 20,000 queued ops");
  const folder = mkdtempSync(join(tmpdir(), "mh-http-stress-"));
  const opened: Database[] = [];
  const open = (name: string) => {
    const sqlite = new Database(join(folder, `${name}.db`));
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    initSchema(sqlite);
    sqlite.query("INSERT OR IGNORE INTO meta(key,value) VALUES ('node_id',?)").run(name);
    opened.push(sqlite);
    return sqlite;
  };
  const relay = open("relay");
  let aSqlite = open("a");
  let measured = measuredDriver(aSqlite);
  let a = measured.driver;
  let bSqlite = open("b");
  const b = measuredDriver(bSqlite).driver;
  const syncRoute = routes.find(route => route.method === "POST" && route.path === "/sync")!;
  const token = "isolated-http-stress-fixture";
  type Fault = "none" | "offline" | "lost-response" | "held-response" | "bad-json" | "unauthorized";
  let fault: Fault = "none";
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const network = { requests: 0, uploadedOps: 0, downloadedOps: 0, maxUploadedPage: 0, maxDownloadedPage: 0, bodyBytes: 0, handlerMs: [] as number[], uniqueUploadedOps: new Set<string>() };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/sync") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${token}` || fault === "unauthorized") return new Response("unauthorized", { status: 401 });
      const request = await req.clone().json() as { changes: import("../src/core/crdt.ts").Change[] };
      const mode = fault;
      network.requests++;
      network.uploadedOps += request.changes.length;
      network.bodyBytes += (await req.clone().arrayBuffer()).byteLength;
      network.maxUploadedPage = Math.max(network.maxUploadedPage, request.changes.length);
      for (const c of request.changes) network.uniqueUploadedOps.add(`${c.hlc}/${c.node_id}/${c.dataset}/${c.row_id}/${c.col}`);
      if (mode === "offline") return new Response("fixture offline", { status: 503 });
      const start = performance.now();
      const response = await syncRoute.handler(req, { db: relay, node: getNodeId(relay) });
      network.handlerMs.push(performance.now() - start);
      const returned = await response.clone().json() as { changes: unknown[] };
      network.downloadedOps += returned.changes.length;
      network.maxDownloadedPage = Math.max(network.maxDownloadedPage, returned.changes.length);
      if (mode === "lost-response") { fault = "none"; return new Response("ack lost after commit", { status: 503 }); }
      if (mode === "bad-json") { fault = "none"; return new Response("{"); }
      if (mode === "held-response") {
        await new Promise<void>(resolve => { release = resolve; reached?.(); });
        fault = "none";
      }
      return response;
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const sync = (db: DbDriver, extra: Parameters<typeof syncWithPeer>[2] = {}) => syncWithPeer(db, url, { token, pushLimit: batchSize, pullLimit: batchSize, ...extra as object });
  const drain = async (db: DbDriver) => {
    let rounds = 0, pushed = 0, pulled = 0;
    do {
      const result = await sync(db);
      rounds++; pushed += result.pushed; pulled += result.pulled;
      if (!result.pendingPush && (result.received ?? 0) < batchSize) return { rounds, pushed, pulled };
      await turn();
    } while (rounds < Math.ceil(queuedOps / batchSize) * 5 + 30);
    throw new Error("fixture failed to drain");
  };
  const phases: Record<string, number> = {};
  let currentPhase = "setup", previous = performance.now();
  const gaps: Record<string, number> = {};
  const timer = setInterval(() => { const now = performance.now(); gaps[currentPhase] = Math.max(gaps[currentPhase] ?? 0, now - previous); previous = now; }, 10);
  const phase = (name: string) => { currentPhase = name; options.progress?.(name); };
  const assertions: string[] = [];
  try {
    phase("seed");
    const seedStart = performance.now();
    const table = createDatabase(a, { name: "Isolated network stress" });
    const title = addProperty(a, table.id, { name: "Title", type: "text" });
    const number = addProperty(a, table.id, { name: "Number", type: "number" });
    const records = Math.ceil(queuedOps / 4);
    for (let base = 0; base < records; base += 50) {
      withChangeGroup(a, "stress-seed", () => {
        for (let i = base; i < Math.min(base + 50, records); i++) {
          const id = `rec_stress_${String(i).padStart(6, "0")}`;
          emit(a, "records", id, "database_id", table.id);
          emit(a, "records", id, "order_key", String(i).padStart(8, "0"));
          emit(a, "records", id, title.id, `Queued record ${i}`);
          emit(a, "records", id, number.id, i);
        }
      });
      await turn();
    }
    const doc = createDocument(a, { title: "Concurrent document", body: "Initial body" });
    phases.seedMs = performance.now() - seedStart;
    const initialOps = count(a);
    check(initialOps >= queuedOps, "seed did not queue >=20,000 operations");
    check(count(relay) === 0 && count(b) === 0, "fixture must start isolated");
    const sqlBefore = { ...measured.stats };
    phase("upload");
    const uploadStart = performance.now();
    const uploaded = await drain(a);
    phases.uploadMs = performance.now() - uploadStart;
    check(count(relay) === initialOps, "relay did not receive every queued op");
    check(network.uniqueUploadedOps.size >= queuedOps, "network did not transport >=20,000 unique ops");
    check(uploaded.pushed >= queuedOps, "upload count below queued operations");
    check(stable(cursors(a, url)) === stable({ pull_cursor: initialOps, push_cursor: initialOps }), "fully drained cursors incorrect");
    assertions.push("at least 20,000 unique queued operations transported over real localhost HTTP");
    const sqlAfter = { ...measured.stats };
    phase("hydrate");
    const hydrateStart = performance.now();
    const hydrated = await drain(b);
    phases.hydrateMs = performance.now() - hydrateStart;
    check(count(b) === initialOps, "hydration lost operations");
    check(hydrated.pulled === initialOps, "hydration reported incorrect unique operation count");
    check(network.maxUploadedPage <= batchSize && network.maxDownloadedPage <= batchSize, "unbounded network page");
    assertions.push("bounded upload and pull pages hydrate all operations");

    phase("offline");
    updateRecord(a, "rec_stress_000000", { [title.id]: "Offline persisted edit" });
    const beforeOffline = stable(cursors(a, url));
    fault = "offline";
    const scheduler = createReplicaSync(a, { targets: () => [{ kind: "http", url, token }], batchSize, pagesPerRound: 1 });
    await scheduler.syncNow();
    check(scheduler.status.pendingPush > 0 && !!scheduler.status.error && !scheduler.status.connected, "offline status lost pending edits");
    await scheduler.stop();
    check(stable(cursors(a, url)) === beforeOffline, "offline attempt advanced cursors");
    check(getRecord(a, "rec_stress_000000")?.cells[title.id] === "Offline persisted edit", "offline local read lost edit");
    fault = "none";
    aSqlite.close();
    aSqlite = open("a"); measured = measuredDriver(aSqlite); a = measured.driver;
    check(stable(cursors(a, url)) === beforeOffline, "reopen lost durable cursors");
    check(getRecord(a, "rec_stress_000000")?.cells[title.id] === "Offline persisted edit", "reopen lost pending offline write");
    await drain(a);
    assertions.push("offline branch retains pending edits and durable cursors through close/reopen");

    phase("replay");
    updateRecord(a, "rec_stress_000001", { [title.id]: "Ack replay" });
    const beforeLost = stable(cursors(a, url));
    fault = "lost-response";
    let lost = false;
    try { await sync(a); } catch { lost = true; }
    check(lost && stable(cursors(a, url)) === beforeLost, "lost response acknowledged prematurely");
    check(getRecord(relay, "rec_stress_000001")?.cells[title.id] === "Ack replay", "lost response was not applied remotely");
    const afterLostCount = count(relay);
    await drain(a);
    check(count(relay) === afterLostCount, "replayed upload duplicated oplog rows");
    updateRecord(a, "rec_stress_000002", { [title.id]: "Decode replay" });
    const beforeDecode = stable(cursors(a, url));
    fault = "bad-json";
    let badJson = false;
    try { await sync(a); } catch { badJson = true; }
    check(badJson && stable(cursors(a, url)) === beforeDecode, "invalid response decoding advanced cursors");
    await drain(a);
    assertions.push("lost acknowledgements and malformed responses replay idempotently without premature cursor advances");

    phase("interruption");
    updateRecord(a, "rec_stress_000003", { [title.id]: "In flight remote commit" });
    const beforeAbort = stable(cursors(a, url));
    fault = "held-response";
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    const controller = new AbortController();
    const interrupted = sync(a, { signal: controller.signal });
    await arrived;
    controller.abort(new Error("fixture background interruption"));
    let aborted = false;
    try { await interrupted; } catch { aborted = true; }
    check(aborted && stable(cursors(a, url)) === beforeAbort, "interrupted response advanced cursors");
    aSqlite.close();
    release?.();
    await turn();
    aSqlite = open("a"); measured = measuredDriver(aSqlite); a = measured.driver;
    await drain(a);
    check(getRecord(a, "rec_stress_000003")?.cells[title.id] === "In flight remote commit", "interruption recovery lost write");
    assertions.push("in-flight interruption permits close/reopen and replays the remotely committed page");

    phase("concurrent");
    await drain(b);
    updateRecord(a, "rec_stress_000004", { [title.id]: "A offline title" });
    updateRecord(b, "rec_stress_000004", { [number.id]: 99999 });
    updateDocument(a, doc.id, { title: "A offline document title" });
    updateDocument(b, doc.id, { body: "B offline document body" });
    updateRecord(a, "rec_stress_000005", { [title.id]: "Edit raced delete" });
    deleteRecord(b, "rec_stress_000005");
    deleteDocument(b, doc.id);
    // Writes from both offline branches are interleaved over independent HTTP requests.
    await Promise.all([drain(a), drain(b)]);
    await drain(a); await drain(b); await drain(a);
    const rowA = getRecord(a, "rec_stress_000004"), rowB = getRecord(b, "rec_stress_000004");
    check(stable(rowA) === stable(rowB) && rowA?.cells[title.id] === "A offline title" && rowA?.cells[number.id] === 99999, "concurrent record fields did not converge");
    check(!getRecord(a, "rec_stress_000005") && !getRecord(b, "rec_stress_000005"), "concurrent edit/delete resurrected a record");
    check(!getDocument(a, doc.id) && !getDocument(b, doc.id), "concurrent edit/delete resurrected a document");
    for (const table of ["databases", "properties", "records", "documents", "doc_blocks"]) {
      const snapshot = (db: DbDriver) => stable(db.query(`SELECT * FROM ${table} ORDER BY id`).all());
      check(snapshot(a) === snapshot(b) && snapshot(a) === snapshot(relay), `materialized ${table} diverged`);
    }
    assertions.push("concurrent offline edits, document changes and edit/delete races converge across three nodes");

    phase("cursorRecovery");
    const beforeResetCount = count(a);
    a.query("UPDATE peers SET pull_cursor = 0 WHERE url = ?").run(url);
    const resetResult = await drain(a);
    check(resetResult.pulled === 0 && resetResult.rounds > 1 && count(a) === beforeResetCount, "cursor reset replay duplicated or prematurely exhausted known pages");
    fault = "unauthorized";
    const authBefore = stable(cursors(a, url));
    let authError = false;
    try { await sync(a); } catch (error) { authError = (error as { code?: string }).code === "auth"; }
    check(authError && stable(cursors(a, url)) === authBefore, "revoked auth did not preserve cursors");
    fault = "none";
    assertions.push("reset pull cursor drains all-known full pages; revoked auth preserves durable cursors");
    return {
      environment: { runtime: `Bun ${Bun.version}`, platform: process.platform, arch: process.arch, transport: "real localhost HTTP, production /sync route", database: "isolated temporary WAL SQLite files", nativePerformanceClaim: false },
      fixture: { queuedOps: initialOps, records, batchSize, nodes: 3 },
      assertions,
      functionalAssertions: "PASS",
      phases,
      upload: uploaded, hydration: hydrated, resetReplay: resetResult,
      network: { ...network, uniqueUploadedOps: network.uniqueUploadedOps.size, handlerMs: { p50: percentile(network.handlerMs, .5), p95: percentile(network.handlerMs, .95), max: Math.max(...network.handlerMs) } },
      uploadSql: Object.fromEntries(Object.keys(sqlAfter).map(key => [key, sqlAfter[key as keyof typeof sqlAfter] - sqlBefore[key as keyof typeof sqlBefore]])),
      maxObservedTimerGapMs: gaps, timerIntervalMs: 10,
    };
  } finally {
    clearInterval(timer); release?.();
    await server.stop(true);
    for (const sqlite of opened) { try { sqlite.close(); } catch {} }
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runReplicaHttpStress({ progress: phase => console.error(`[replica-http-stress] ${phase}`) });
  if (process.argv[2]) await Bun.write(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
