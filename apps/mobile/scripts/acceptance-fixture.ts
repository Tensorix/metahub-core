/** Durable, synthetic-only native acceptance fixture. Run with Bun from any cwd.
 * prepare <readonly-source-db> <new-private-directory>
 * serve|inspect|pull|push|verify <private-directory> [bucket|server]
 * edit <private-directory> <bucket|server> <ios|android> <Notes|Status|document> <value>
 * pull runs the shared two-way synchronization round; push skips remote pulls.
 * Private directory must be under apps/mobile/dist/acceptance/private/. Never deletes bucket objects.
 * Invitations, connection settings and failure details stay inside that ignored private directory.
 */
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import createQRCode from "qrcode-generator";
import { initSchema } from "../../../src/core/schema-init.ts";
import { createReplicaService } from "../../../src/core/replica/service.ts";
import { getNodeId } from "../../../src/core/node.ts";
import { addStoragePeer } from "../../../src/core/sync/peers.ts";
import { createFetchStorageClient } from "../../../src/core/sync/storage-s3-fetch.ts";
import { storageUrl } from "../../../src/core/sync/storage-url.ts";
import { encodeRecoveryCode } from "../../../src/core/sync/recovery.ts";
import { fromB64 } from "../../../src/core/sync/e2ee.ts";
import { mobileEnrollUrl } from "../../../src/core/sync/enroll.ts";
import { blobHash, sha256Hex } from "../../../src/core/cache.ts";
import { recordBlob } from "../../../src/core/blobs-core.ts";
import { getBucketBlob, provisionMasterKey, putBucketBlob, setStorageClientFactory, syncWithStorage, type S3Config, type StorageClient } from "../../../src/core/sync/storage.ts";

const privateRoot = resolve(import.meta.dir, "../dist/acceptance/private");
const markerName = "fixture-owner.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const [command, ...args] = process.argv.slice(2);
let root = "";
let privateOwned = false;
let stage = "arguments";
type Platform = "ios" | "android";
type Transport = "bucket" | "server";
type IDs = { database: string; name: string; properties: Record<string, string>; records: string[]; document: string; documentTitle: string };
export type Manifest = { kind: "metahub-native-acceptance"; version: 1; id: string; createdAt: string; parentPrefix: string; prefix: string; configHash: string; status: string };
type PublicFixture = { id: string; server: Record<Platform, IDs>; bucket: Record<Platform, IDs>; samples: { name: string; hash: string; sha256: string; bytes: number; mime: string }[]; searchDocuments: number };
function check(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(why); }
function contained(path: string, parent: string) { const r = relative(parent, path); return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r); }
async function file(name: string, value: string | Uint8Array) { const path = join(root, name); await Bun.write(path, value); await chmod(path, 0o600); }
async function json(name: string, value: unknown) { await file(name, JSON.stringify(value, null, 2) + "\n"); }
async function read<T>(name: string): Promise<T> { return await Bun.file(join(root, name)).json() as T; }
async function lockPrivateTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const name of await readdir(path)) {
    const p = join(path, name), st = await lstat(p);
    check(!st.isSymbolicLink(), "Private artifacts must not be symlinks");
    if (st.isDirectory()) await lockPrivateTree(p); else await chmod(p, 0o600);
  }
}
function normalizedPrefix(p: string) {
  const clean = (p || "").replace(/^\/+|\/+$/g, "");
  check(!/[\\\x00-\x1f]/.test(clean) && !clean.split("/").some(s => s === "." || s === ".."), "Invalid parent prefix");
  return clean;
}
function ownPrefix(parent: string, id: string) { check(uuidPattern.test(id), "Invalid owner UUID"); return [normalizedPrefix(parent), "_mobile-ui-acceptance", id].filter(Boolean).join("/"); }
async function requireRoot(input: string, existing: boolean) {
  root = resolve(input);
  check(contained(root, privateRoot), "Fixture directory must be beneath ignored private root");
  if (existing) {
    await assertExistingFixtureDirectory(root);
  } else {
    check(!(await Bun.file(join(root, markerName)).exists()), "Existing fixture must never be replaced");
    try { await lstat(root); throw new Error("Existing directory must never be replaced"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    check(await realpath(privateRoot) === privateRoot, "Private root must not traverse symlinks");
    await chmod(privateRoot, 0o700);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    check(await realpath(dirname(root)) === dirname(root), "Fixture parent must not traverse symlinks");
    await mkdir(root, { mode: 0o700 });
  }
}
async function owner() {
  const m = await read<Manifest>(markerName);
  check(m.kind === "metahub-native-acceptance" && m.version === 1 && m.prefix === ownPrefix(m.parentPrefix, m.id), "Missing or invalid ownership marker");
  privateOwned = true;
  return m;
}
const configDigest = (c: S3Config) => sha256Hex(new TextEncoder().encode(JSON.stringify(c)));
export function assertFixtureIdentity(config: S3Config, manifest: Manifest): void {
  check(manifest.kind === "metahub-native-acceptance" && manifest.version === 1, "Missing or invalid ownership marker");
  check(config.prefix === manifest.prefix && config.prefix === ownPrefix(manifest.parentPrefix, manifest.id), "Unsafe bucket prefix");
  if (manifest.configHash) check(configDigest(config) === manifest.configHash, "Fixture config fingerprint mismatch");
  else check(manifest.status === "preparing", "Unsealed ready fixture config");
}
export async function assertExistingFixtureDirectory(path: string, allowedRoot = privateRoot): Promise<void> {
  check(contained(resolve(path), resolve(allowedRoot)), "Fixture directory must be beneath ignored private root");
  check(await realpath(path) === resolve(path), "Fixture directory must not traverse symlinks");
  check((await lstat(path)).isDirectory(), "Fixture directory missing");
}
export function createGuardedClient(config: S3Config, manifest: Manifest, raw: StorageClient, recordPut: (key: string, bytes: Uint8Array) => Promise<void>): StorageClient {
  assertFixtureIdentity(config, manifest);
  const keyCheck = (key: string) => {
    assertFixtureIdentity(config, manifest);
    check(key.startsWith(config.prefix + "/") && !key.split("/").some(p => p === ".." || p === ".") && !/[\\\x00-\x1f]/.test(key), "Object outside owned child prefix");
  };
  return {
    async list(prefix, startAfter, delimiter) { keyCheck(prefix); if (startAfter) keyCheck(startAfter); const objects = await raw.list(prefix, startAfter, delimiter); for (const obj of objects) keyCheck(obj.key); return objects; },
    async get(key, options) { keyCheck(key); return raw.get(key, options); },
    async put(key, bytes, options) { keyCheck(key); await recordPut(key, bytes); await raw.put(key, bytes, options); },
    async del() { throw new Error("Fixture tooling never deletes remote objects"); },
  };
}
function guarded(config: S3Config, manifest: Manifest): StorageClient {
  assertFixtureIdentity(config, manifest);
  return createGuardedClient(config, manifest, createFetchStorageClient(config), async (key, bytes) => {
    // Intent is durable BEFORE the network write; a crash never loses ownership evidence.
    const ledger = await read<{ puts: { key: string; sha256: string; at: string }[] }>("ownership-ledger.json");
    ledger.puts.push({ key, sha256: sha256Hex(bytes), at: new Date().toISOString() });
    await json("ownership-ledger.json", ledger);
  });
}
async function loadBucket(m: Manifest) {
  const config = await read<S3Config>("bucket-config.json");
  check(configDigest(config) === m.configHash, "Fixture config fingerprint mismatch");
  setStorageClientFactory(c => { check(configDigest(c) === m.configHash, "Unexpected bucket config"); return guarded(c, m); });
  return config;
}
function openDb(transport: Transport, readonly = false) {
  const db = new Database(join(root, transport, "metahub.db"), { readonly, create: !readonly });
  if (!readonly) { db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;"); initSchema(db); getNodeId(db); }
  return db;
}
function transportOf(value: string | undefined): Transport { check(value === "server" || value === "bucket", "Choose server or bucket"); return value; }
function platformOf(value: string | undefined): Platform { check(value === "ios" || value === "android", "Choose ios or android"); return value; }
async function prepare() {
  const [source, destination] = args;
  check(source && destination, "Usage: prepare <readonly-source-db> <new-private-directory>");
  await requireRoot(destination, false);
  stage = "read-source-access-only";
  const sourceDb = new Database(resolve(source), { readonly: true });
  let access: S3Config;
  try {
    const rows = sourceDb.query("SELECT config FROM peers WHERE kind='s3' AND enabled=1").all() as {config: string}[];
    check(rows.length === 1, "Source must have exactly one enabled S3 peer");
    const c = JSON.parse(rows[0]!.config) as S3Config;
    check(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey, "Incomplete source access settings");
    access = { endpoint: c.endpoint, region: c.region || "auto", bucket: c.bucket, prefix: normalizedPrefix(c.prefix), accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, encrypt: true, virtualHostedStyle: c.virtualHostedStyle };
  } finally { sourceDb.close(); }
  const id = crypto.randomUUID();
  const manifest: Manifest = { kind: "metahub-native-acceptance", version: 1, id, createdAt: new Date().toISOString(), parentPrefix: access.prefix, prefix: ownPrefix(access.prefix, id), configHash: "", status: "preparing" };
  const config: S3Config = { ...access, prefix: manifest.prefix, publish: false };
  await json(markerName, manifest);
  privateOwned = true;
  await json("ownership-ledger.json", { ownerId: id, noDeletes: true, puts: [] });
  await json("bucket-config.json", config);
  stage = "check-new-owned-child-empty";
  const client = guarded(config, manifest);
  check((await client.list(config.prefix + "/")).length === 0, "Fresh child prefix is not empty; refusing adoption");
  const passphrase = `SyntheticMobile${crypto.randomUUID().replaceAll("-", "")}`;
  await file("bucket-passphrase.txt", passphrase + "\n");
  stage = "provision-owned-child-key";
  config.masterKey = (await provisionMasterKey(client, config, passphrase))!;
  check(config.masterKey, "Encrypted fixture key missing");
  manifest.configHash = configDigest(config);
  await json("bucket-config.json", config);
  await json(markerName, manifest);
  await file("bucket-recovery-code.txt", await encodeRecoveryCode(fromB64(config.masterKey)) + "\n");
  await loadBucket(manifest);
  stage = "seed-isolated-desktop-and-server";
  const text = new TextEncoder().encode("Metahub synthetic attachment 20261028\n双向验收 synthetic only\n");
  const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=", "base64"));
  const samples = [{ name: "synthetic-attachment-20261028.txt", bytes: text, mime: "text/plain" }, { name: "synthetic-pixel-20261028.png", bytes: png, mime: "image/png" }];
  const fixture: PublicFixture = { id, bucket: {} as Record<Platform, IDs>, server: {} as Record<Platform, IDs>, samples: samples.map(s => ({ name: s.name, hash: blobHash(s.bytes), sha256: sha256Hex(s.bytes), bytes: s.bytes.length, mime: s.mime })), searchDocuments: 65 };
  await mkdir(join(root, "samples"), { mode: 0o700 });
  for (const sample of samples) await file(`samples/${sample.name}`, sample.bytes);
  for (const transport of ["bucket", "server"] as const) {
    await mkdir(join(root, transport, "cache"), { recursive: true, mode: 0o700 });
    const db = openDb(transport);
    try {
      const service = createReplicaService(db), api = service.commands;
      for (const sample of samples) {
        const hash = blobHash(sample.bytes);
        await file(`${transport}/cache/${hash}`, sample.bytes);
        recordBlob(db, hash, sample.bytes.length, sample.mime, 0);
      }
      for (const platform of ["ios", "android"] as const) {
        const label = platform === "ios" ? "iOS" : "Android";
        const name = `${label} Native ${transport === "bucket" ? "Bucket" : "Server"}20261028`;
        const database = api.createDatabase({ name });
        const properties = Object.fromEntries([
          api.addProperty(database.id, { name: "Title", type: "text" }),
          api.addProperty(database.id, { name: "Status", type: "select", config: { options: ["Todo", "Doing", "Done"] } }),
          api.addProperty(database.id, { name: "Notes", type: "text" }),
          api.addProperty(database.id, { name: "Document", type: "doc" }),
        ].map(p => [p.name, p.id]));
        const document = api.createDocument({ title: `${label} Native ${transport === "bucket" ? "Bucket" : "Server"} Document20261028`, database_id: database.id, body: `Synthetic Mobile Acceptance 20261028\n\n中文输入与 English text. Only synthetic data.\n\n[synthetic attachment](/blob/${blobHash(text)}.txt)\n\n![synthetic pixel](/blob/${blobHash(png)}.png)` });
        const records = ["Todo", "Done"].map(status => api.createRecord(database.id, { Title: `${label} ${transport === "bucket" ? "Bucket" : "Server"} ${status}20261028`, Status: status, Notes: `${label} Synthetic Notes20261028`, Document: [document.id] }).id);
        api.updateDatabase(database.id, { meta: { views: [{ id: "v_table", name: "表格", layout: "table", sort: [], filter: { op: "and", rules: [] }, hidden: [] }, { id: "v_board", name: "看板", layout: "board", group: properties.Status, sort: [], filter: { op: "and", rules: [] }, hidden: [] }] } });
        fixture[transport][platform] = { database: database.id, name, properties, records, document: document.id, documentTitle: document.title };
      }
      for (let n = 1; n <= fixture.searchDocuments; n++) api.createDocument({ title: `MobileSearch20261028 搜索分页 ${String(n).padStart(2, "0")}`, body: `Synthetic bilingual search fixture 文档 ${n} / 65` });
      if (transport === "bucket") addStoragePeer(db, { url: storageUrl(config.endpoint, config.bucket, config.prefix), config, label: "Synthetic Mobile Acceptance 20261028" });
      service.dispose();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
  }
  await json("fixture-public.json", fixture);
  await json("server-connect.json", { url: "http://127.0.0.1:8991", token: "native-acceptance-local-only", home: join(root, "server"), persistent: true, synthetic: true });
  const link = mobileEnrollUrl(config), qr = createQRCode(0, "M"); qr.addData(link); qr.make();
  await file("enrollment.txt", link + "\n");
  await file("enrollment.gif", Buffer.from(qr.createDataURL(5, 20).split(",")[1]!, "base64"));
  await file("index.html", `<!doctype html><meta charset="utf-8"><title>Synthetic Mobile Acceptance</title><h1>Synthetic Mobile Acceptance 20261028</h1><p>Only this new isolated workspace. Enter the private fixture passphrase separately.</p><img src="enrollment.gif"><p><a href="${link}">Connect synthetic bucket</a></p>`);
  stage = "publish-owned-child";
  await syncBucket(manifest, config, "push");
  for (const sample of samples) await putBucketBlob(config, blobHash(sample.bytes), sample.bytes);
  manifest.status = "ready"; await json(markerName, manifest);
  await lockPrivateTree(root);
  await inspect("bucket");
}
async function syncBucket(m: Manifest, config: S3Config, direction: "pull" | "push") {
  const db = openDb("bucket");
  try {
    return await syncWithStorage(db, storageUrl(config.endpoint, config.bucket, config.prefix), guarded(config, m), config, { publish: false, pull: direction === "pull", pushLimit: 1000, ingestBatchSize: 100, snapshotEverySegments: Number.MAX_SAFE_INTEGER });
  } finally { db.close(); }
}
async function inspect(transport: Transport) {
  const m = await owner(), f = await read<PublicFixture>("fixture-public.json"), db = openDb(transport, true);
  const service = createReplicaService(db);
  try {
    const api = service.commands;
    const platforms = Object.fromEntries((["ios", "android"] as const).map(p => {
      const ids = f[transport][p];
      return [p, { ...ids, values: ids.records.map(id => api.getRecord(id).values), body: api.getDocument(ids.document).body }];
    }));
    const result = { status: m.status, fixtureId: m.id, transport, directory: root, platforms, attachmentSamples: f.samples, counts: Object.fromEntries(["databases", "records", "documents", "properties"].map(table => [table, (db.query(`SELECT count(*) AS n FROM ${table} WHERE __deleted=0`).get() as {n: number}).n])) };
    await json(`latest-${transport}-inspection.json`, result);
    console.log(JSON.stringify(result));
  } finally { service.dispose(); db.close(); }
}
async function main() {
  if (command === "prepare") return await prepare();
  check(args[0], "Private fixture directory required"); await requireRoot(args[0], true);
  const m = await owner();
  if (command === "serve") {
    process.env.METAHUB_HOME = join(root, "server"); process.env.METAHUB_APP = "server";
    check(await Bun.file(join(process.env.METAHUB_HOME, "metahub.db")).exists(), "Prepared persistent server database missing");
    const { startServer } = await import("../../../src/core/sync/server.ts");
    const { webuiRoutes, webuiOnStart } = await import("../../../src/webui/server/routes.ts");
    const server = startServer({ host: "127.0.0.1", port: 8991, token: "native-acceptance-local-only", autoSync: false, ui: { routes: webuiRoutes, onStart: webuiOnStart, serveAssets: async () => null } });
    await file("server.pid", String(process.pid) + "\n");
    await lockPrivateTree(root);
    console.log(JSON.stringify({ status: "ready", host: server.host, port: server.port, home: process.env.METAHUB_HOME, fixtureId: m.id }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(); process.exit(0); });
    return;
  }
  const transport = transportOf(args[1] ?? "bucket");
  if (command === "edit") {
    stage = "edit-owned-synthetic";
    const platform = platformOf(args[2]), field = args[3], value = args[4];
    check(value !== undefined && value.length <= 100000 && !/[\x00-\x08]/.test(value), "Synthetic edit value required");
    check(field === "Notes" || field === "Status" || field === "document", "Only fixture Notes, Status or document edits are allowed");
    const fixture = await read<PublicFixture>("fixture-public.json"), ids = fixture[transport][platform], db = openDb(transport);
    const service = createReplicaService(db);
    try {
      const api = service.commands;
      const databases = api.listDatabases();
      check(databases.some(d => d.id === ids.database && d.name === ids.name), "Synthetic database identity changed; refusing edit");
      check(ids.records.length === 2 && api.getRecord(ids.records[0]!).database_id === ids.database, "Synthetic record identity invalid");
      check(api.getDocument(ids.document).title === ids.documentTitle, "Synthetic document identity changed; refusing edit");
      if (field === "document") api.updateDocument(ids.document, { body: `${api.getDocument(ids.document).body ?? ""}\n\n${value}` });
      else api.updateRecord(ids.records[0]!, { [ids.properties[field]!]: value });
    } finally { service.dispose(); db.close(); }
    console.log(JSON.stringify({ status: "edited-locally", transport, platform, field, pushRequired: transport === "bucket" }));
  } else if (command === "pull" || command === "push") {
    check(transport === "bucket", "Server data uses local persisted API, no bucket sync");
    stage = "sync-own-prefix"; const config = await loadBucket(m);
    console.log(JSON.stringify({ status: "synced", direction: command, result: await syncBucket(m, config, command) }));
  } else if (command === "verify") {
    check(transport === "bucket", "Remote verify currently supports bucket only");
    stage = "verify-owned-child-attachment"; const config = await loadBucket(m), fixture = await read<PublicFixture>("fixture-public.json");
    const verifier = new Database(":memory:"); initSchema(verifier); getNodeId(verifier);
    const peer = storageUrl(config.endpoint, config.bucket, config.prefix);
    addStoragePeer(verifier, { url: peer, config });
    const remote = guarded(config, m);
    const readOnlyRemote: StorageClient = { list: remote.list, get: remote.get, async put() { throw new Error("Verification must never upload"); }, async del() { throw new Error("Verification must never delete"); } };
    const hydration = await syncWithStorage(verifier, peer, readOnlyRemote, config, { publish: false, ingestBatchSize: 100 });
    const desktop = openDb("bucket", true);
    const canonical = (db: Database, table: string) => JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY id`).all());
    try {
      for (const table of ["databases", "properties", "records", "documents", "doc_blocks"]) check(canonical(verifier, table) === canonical(desktop, table), "Remote and desktop synthetic state differs; run pull then verify");
    } finally { desktop.close(); verifier.close(); }
    const blobs = [];
    for (const sample of fixture.samples) { const bytes = await getBucketBlob(config, sample.hash); check(bytes && sha256Hex(bytes) === sample.sha256, "Synthetic remote attachment hash mismatch"); blobs.push({ name: sample.name, sha256: sample.sha256, bytes: bytes.length, verified: true }); }
    console.log(JSON.stringify({ status: "verified", fixtureId: m.id, freshReplicaCanonicalMatch: true, hydration, ownPrefixObjects: (await guarded(config, m).list(config.prefix + "/")).length, blobs }));
  } else check(command === "inspect", "Unknown fixture command");
  await inspect(transport); await lockPrivateTree(root);
}
if (import.meta.main) {
process.umask(0o077);
try { await main(); } catch (error) {
  // Raw provider messages can contain signed URLs/configuration. Never send them to stdout/stderr.
  if (privateOwned && root && await Bun.file(join(root, markerName)).exists()) {
    await mkdir(join(root, "failures"), { recursive: true, mode: 0o700 }).catch(() => {});
    const failure = { stage, at: new Date().toISOString(), message: error instanceof Error ? error.message : "Unknown failure", stack: error instanceof Error ? error.stack : undefined };
    await json(`failures/${Date.now()}-${crypto.randomUUID()}.json`, failure).catch(() => {});
    await json("last-failure-private.json", failure).catch(() => {});
  }
  console.error(JSON.stringify({ status: "failed", stage, reason: "fixture-operation-failed", privateDetails: privateOwned ? join(root, "last-failure-private.json") : undefined })); process.exitCode = 1;
}

}
