import { createV2Bucket } from "../src/core/sync/bucket-v2.ts";
import { MhError } from "../src/core/errors.ts";
/** Reproducible synthetic workload; never opens a user's database or bucket.
 * Timings are local Bun/SQLite measurements, not mobile/network guarantees. */
import { Database } from "bun:sqlite";
import { runSchema } from "../src/core/db.ts";
import { createDocument, updateDocument, documentVersion, getDocument } from "../src/core/documents.ts";
import { CHANGE_SELECT, ingestDetailed } from "../src/core/crdt.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "../src/core/sync/current-checkpoint.ts";
import { captureDocumentArchive } from "../src/core/history-archive.ts";
import { writeReplicaGeneration } from "../src/core/sync/retention-protocol.ts";
import { gzipStorageBytes, publishSnapshot, syncWithStorage, type StorageClient, type StorageReadResult, type S3Config } from "../src/core/sync/storage.ts";
const dataset = { documents: 20, editsPerDocument: 100, paragraphs: 3 };
const dbs: Database[] = [];
function database() { const db = new Database(":memory:"); runSchema(db); dbs.push(db); return db; }
const round = (n: number) => Math.round(n * 100) / 100;
const size = async (value: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); return { jsonBytes: bytes.length, gzipBytes: (await gzipStorageBytes(bytes)).length }; };
try {
  const results = [];
  for (const mode of ["legacy", "v2"] as const) {
    const db = database(), ids: string[] = [], start = performance.now();
    if (mode === "v2") writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "synthetic", epoch: 0, incarnationId: "benchmark", checkpoint: null });
    for (let d = 0; d < dataset.documents; d++) {
      const body = (n: number) => `Document ${d} editable paragraph revision ${n}.\n\nRetained middle paragraph.\n\nRetained final paragraph.`;
      const doc = createDocument(db, { title: `Synthetic ${d}`, body: body(0) }); ids.push(doc.id);
      for (let n = 1; n <= dataset.editsPerDocument; n++) updateDocument(db, doc.id, { body: body(n) }, mode === "v2" ? { ifMatch: documentVersion(db,doc.id) } : {});
    }
    const editingMs = performance.now() - start;
    const projection = db.query(`SELECT ${CHANGE_SELECT} FROM crdt_changes c WHERE NOT EXISTS
      (SELECT 1 FROM crdt_changes k WHERE k.dataset=c.dataset AND k.row_id=c.row_id AND k.col=c.col AND k.hlc>c.hlc) ORDER BY dataset,row_id,col`).all();
    const checkpoint = captureCurrentCheckpoint(db,"synthetic",0);
    if (mode === "v2") checkpoint.history = ids.map(documentId => ({ documentId, hash: "0".repeat(64) }));
    const payload = mode === "v2" ? checkpoint : projection;
    const serialized = JSON.stringify(payload), parseStart = performance.now(), parsed = JSON.parse(serialized), parseMs = performance.now() - parseStart;
    const shadow = database(), installStart = performance.now();
    if (mode === "v2") installCurrentCheckpoint(shadow, parsed,"synthetic"); else ingestDetailed(shadow, parsed);
    const installMs = performance.now() - installStart;
    for (const id of ids) if (getDocument(db,id)?.body !== getDocument(shadow,id)?.body) throw new Error("current content mismatch");
    let historyJsonBytes = 0, historyGzipBytes = 0;
    if (mode === "v2") for (const id of ids) { const bytes = await size(captureDocumentArchive(db,"synthetic",id)); historyJsonBytes += bytes.jsonBytes; historyGzipBytes += bytes.gzipBytes; }
    const objects = new Map<string, StorageReadResult>();
    const requests = { get: 0, put: 0, list: 0, del: 0, capabilityChecks: 0 };
    let clock = Date.now();
    const client: StorageClient = {
      conditionalCreateCapability: async () => { requests.capabilityChecks++; return true; },
      get: async key => { requests.get++; return objects.get(key)?.bytes ?? null; },
      getWithMetadata: async key => { requests.get++; const value = objects.get(key); return value ? { ...value, serverDate: clock } : null; },
      list: async (prefix, after) => { requests.list++; return [...objects.keys()].filter(k => k.startsWith(prefix) && (!after || k > after)).sort().map(key => ({ key })); },
      put: async (key, bytes, opts) => { requests.put++; if (opts?.ifNoneMatch && objects.has(key)) throw new MhError("conflict","occupied"); objects.set(key,{ bytes, serverDate: ++clock, lastModified: clock, etag: null }); },
      del: async key => { requests.del++; objects.delete(key); },
    };
    const config: S3Config = { endpoint: "https://synthetic.invalid", bucket: "synthetic", region: "test", prefix: "benchmark", encrypt: false, accessKeyId: "synthetic", secretAccessKey: "synthetic", publish: false };
    const bucket = createV2Bucket(client,config);
    if (mode === "v2") {
      for (const ref of checkpoint.history) ref.hash = await bucket.publish(captureDocumentArchive(db,"synthetic",ref.documentId));
      await bucket.initialize(checkpoint);
    } else await publishSnapshot(db,client,config);
    const publishRequests = { ...requests };
    for (const key of Object.keys(requests) as (keyof typeof requests)[]) requests[key] = 0;
    const joining = database(), bootstrapStart = performance.now();
    if (mode === "v2") {
      const root = (await bucket.root())!;
      installCurrentCheckpoint(joining,await bucket.checkpointFor(root,root.checkpoint,0),"synthetic");
      writeReplicaGeneration(joining,{ protocolVersion: 2, workspaceId: "synthetic", epoch: 0, incarnationId: "joining", checkpoint: root.checkpoint });
    }
    await syncWithStorage(joining,"synthetic",client,config);
    const bootstrapMs = performance.now() - bootstrapStart;
    for (const id of ids) if (getDocument(db,id)?.body !== getDocument(joining,id)?.body) throw new Error("sync bootstrap mismatch");
    results.push({ mode, publishRequests, bootstrapRequests: { ...requests }, bootstrapMs: round(bootstrapMs), editingMs: round(editingMs), parseMs: round(parseMs), installMs: round(installMs),
      currentFields: mode === "v2" ? checkpoint.changes.length : projection.length,
      blocks: db.query("SELECT COUNT(*) AS total,SUM(__deleted=0) AS live,SUM(__deleted=1) AS deleted FROM doc_blocks").get(),
      current: await size(payload), separateHistory: { jsonBytes: historyJsonBytes, gzipBytes: historyGzipBytes } });
  }
  console.log(JSON.stringify({ dataset, runtime: Bun.version, timingScope: "local Bun/SQLite; network latency excluded", results },null,2));
} finally { dbs.forEach(db => db.close()); }
