/** Real CLI processes and optional Electron IPC/sidecar, using disposable local
 * SQLite homes, profiles and an in-memory S3-compatible fixture. No live bucket. */
import { mkdtemp, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMetahub } from "../src/core/db.ts";
import { createDocument, getDocument } from "../src/core/documents.ts";
import { getNodeId } from "../src/core/node.ts";
import { addPeer, addStoragePeer } from "../src/core/sync/peers.ts";
import { readReplicaGeneration, writeReplicaGeneration } from "../src/core/sync/retention-protocol.ts";
import { createV2Bucket } from "../src/core/sync/bucket-v2.ts";
import { captureCurrentCheckpoint } from "../src/core/sync/current-checkpoint.ts";
import { startServer } from "../src/core/sync/server.ts";
import { storageUrl } from "../src/core/sync/storage-url.ts";
import { MhError } from "../src/core/errors.ts";
import type { StorageClient } from "../src/core/sync/storage.ts";

const directory = await mkdtemp(join(tmpdir(), "mh-bootstrap-native-"));
const originalHome = process.env.METAHUB_HOME;
const objects = new Map<string, { bytes: Uint8Array; at: number }>();
const writes: string[] = [];
const client: StorageClient = {
  conditionalCreateCapability: async () => true,
  list: async prefix => [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })),
  get: async key => objects.get(key)?.bytes ?? null,
  getWithMetadata: async key => { const value = objects.get(key); return value ? { bytes: value.bytes, lastModified: value.at, serverDate: Date.now(), etag: null } : null; },
  put: async (key, bytes, options) => {
    if (options?.ifNoneMatch && objects.has(key)) throw new MhError("conflict", "occupied");
    objects.set(key, { bytes: bytes.slice(), at: Date.now() });
  },
  del: async () => { throw new Error("fixture deletes forbidden"); },
};
const bucketServer = Bun.serve({ hostname: "localhost", port: 0, async fetch(req) {
  const url = new URL(req.url), key = decodeURIComponent(url.pathname.slice("/synthetic/".length));
  if (req.method === "GET" && url.searchParams.has("list-type")) {
    const prefix = url.searchParams.get("prefix") ?? "";
    return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${[...objects.keys()].filter(k => k.startsWith(prefix)).map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.bytes.length}</Size></Contents>`).join("")}</ListBucketResult>`, { headers: { "content-type": "application/xml" } });
  }
  if (!url.pathname.startsWith("/synthetic/")) return new Response("missing", { status: 404 });
  if (req.method === "PUT") {
    if (req.headers.get("if-none-match") === "*" && objects.has(key)) return new Response("occupied", { status: 412 });
    writes.push(key); objects.set(key, { bytes: new Uint8Array(await req.arrayBuffer()), at: Date.now() }); return new Response(null);
  }
  const value = objects.get(key);
  return value ? new Response(req.method === "HEAD" ? null : new Uint8Array(value.bytes), { headers: { date: new Date().toUTCString(), "last-modified": new Date(value.at).toUTCString(), "content-length": String(value.bytes.length) } }) : new Response("missing", { status: 404 });
} });
const config = { endpoint: `http://localhost:${bucketServer.port}`, region: "test", bucket: "synthetic", prefix: "fixture", encrypt: false, accessKeyId: "test", secretAccessKey: "test" };
const bucketUrl = storageUrl(config.endpoint, config.bucket, config.prefix);
// Localhost is deliberately not a trusted atomic-create provider in production.
// This fixture implements If-None-Match itself; keep the declaration in a
// test-only preload while exercising the actual Bun/SigV4 wire adapter.
const preload = join(directory, "atomic-fixture.ts");
await Bun.write(preload, `
import { createBunStorageClient } from ${JSON.stringify(resolve("src/core/sync/storage-s3-bun.ts"))};
import { setStorageClientFactory } from ${JSON.stringify(resolve("src/core/sync/storage.ts"))};
setStorageClientFactory(config => { const raw = createBunStorageClient(config); return config.endpoint === ${JSON.stringify(config.endpoint)} ? {...raw, conditionalCreateCapability: async () => true} : raw; });
`);
const bunWrapper = join(directory, "fixture-bun");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
await Bun.write(bunWrapper, `#!/bin/sh\nif [ "$1" = run ]; then shift; fi\nexec ${quote(process.execPath)} --preload ${quote(preload)} "$@"\n`); await chmod(bunWrapper, 0o700);
let remote: ReturnType<typeof startServer> | undefined, legacy: ReturnType<typeof startServer> | undefined;
const checks: string[] = [];
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
let sequence = 0;
async function command(home: string, args: string[], expected = 0) {
  const child = Bun.spawn([process.execPath, "--preload", preload, resolve("src/cli/index.ts"), ...args, "--json"], { env: { ...process.env, METAHUB_HOME: home, MH_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Bun.write(join(directory, `cli-${++sequence}.json`), JSON.stringify({ args, exit, stdout, stderr }, null, 2));
    check(exit === expected, `CLI ${args.join(" ")} exited ${exit}: ${stdout} ${stderr}`);
    return JSON.parse(stdout);
  } finally { clearTimeout(timeout); }
}
try {
  const remoteHome = join(directory, "server");
  process.env.METAHUB_HOME = remoteHome;
  const seed = openMetahub();
  const doc = createDocument(seed, { title: "bootstrap acceptance", body: "baseline text" });
  const root = await createV2Bucket(client, config).initialize(captureCurrentCheckpoint(seed, "native-acceptance", 0));
  writeReplicaGeneration(seed, { protocolVersion: 2, workspaceId: root.workspaceId, epoch: 0, checkpoint: root.checkpoint, incarnationId: "server-incarnation" });
  const serverNode = getNodeId(seed);
  seed.query("INSERT INTO peer_grants(token,node_id) VALUES('synthetic-paired','synthetic-client')").run();
  seed.close();
  remote = startServer({ port: 0, host: "127.0.0.1", token: "synthetic-master", autoSync: false });
  const httpUrl = `http://127.0.0.1:${remote.port}`;
  const incarnations = new Set<string>();
  for (const scenario of ["http-fresh", "http-old-empty", "http-paired", "bucket-fresh", "bucket-old-empty"]) {
    const home = join(directory, scenario), isHttp = scenario.startsWith("http");
    let originalNode: string | undefined;
    if (scenario.includes("old-empty")) { const empty = openMetahub(home); originalNode = getNodeId(empty); empty.close(); }
    if (isHttp) await command(home, ["sync", httpUrl, "--token", scenario === "http-paired" ? "synthetic-paired" : "synthetic-master"]);
    else await command(home, ["config", "backup", "connect", "--endpoint", config.endpoint, "--bucket", config.bucket, "--prefix", config.prefix, "--region", config.region, "--access-key", "test", "--secret-key", "test", "--no-encrypt"]);
    const active = openMetahub(home);
    try {
      const generation = readReplicaGeneration(active)!;
      check(generation?.workspaceId === root.workspaceId, `${scenario} did not join the workspace`);
      check(generation.incarnationId !== "server-incarnation" && !incarnations.has(generation.incarnationId), `${scenario} reused an incarnation`);
      incarnations.add(generation.incarnationId);
      check(getNodeId(active) !== serverNode && (!originalNode || getNodeId(active) === originalNode), `${scenario} lost local device identity`);
      check(getDocument(active, doc.id)?.body === "baseline text", `${scenario} did not install current content`);
      check(active.filename !== join(home, "metahub.db"), `${scenario} did not atomically switch`);
      check(Boolean(active.query("SELECT 1 FROM meta WHERE key='sync_v2_baseline_http'").get()) === isHttp, `${scenario} confused HTTP and bucket coverage`);
    } finally { active.close(); }
    await command(home, ["doc", "edit", doc.id, "--old", "baseline", "--new", scenario]);
    await command(home, ["sync"]);
    check(JSON.stringify(await command(home, ["doc", "get", doc.id])).includes(`${scenario} text`), `${scenario} lost edit after reopening`);
    if (isHttp) {
      const server = openMetahub(remoteHome);
      try { check(getDocument(server, doc.id)?.body === `${scenario} text`, `${scenario} did not upload to HTTP server`); }
      finally { server.close(); }
      // Keep the next scenario's expected baseline stable.
      await command(home, ["doc", "edit", doc.id, "--old", scenario, "--new", "baseline"]); await command(home, ["sync"]);
    } else {
      const verifier = join(directory, `${scenario}-verifier`);
      await command(verifier, ["config", "backup", "connect", "--endpoint", config.endpoint, "--bucket", config.bucket, "--prefix", config.prefix, "--region", config.region, "--access-key", "test", "--secret-key", "test", "--no-encrypt"]);
      check(JSON.stringify(await command(verifier, ["doc", "get", doc.id])).includes(`${scenario} text`), `${scenario} edit absent from independent bucket replica`);
      await command(home, ["doc", "edit", doc.id, "--old", scenario, "--new", "baseline"]); await command(home, ["sync"]);
    }
    checks.push(`CLI ${scenario}: install, independent identity, edit, upload, process restart`);
  }
  const deniedHome = join(directory, "unauthorized"), denied = openMetahub(deniedHome), deniedFile = denied.filename;
  denied.close();
  await command(deniedHome, ["sync", httpUrl, "--token", "wrong"], 6);
  const unchanged = openMetahub(deniedHome);
  try { check(unchanged.filename === deniedFile && !readReplicaGeneration(unchanged), "unauthorized attempt activated a replica"); }
  finally { unchanged.close(); }
  checks.push("CLI unauthorized HTTP retains original replica");
  // Keep legacy HTTP supported without advertising bootstrap.
  process.env.METAHUB_HOME = join(directory, "legacy-server");
  const old = openMetahub(); const oldDoc = createDocument(old, { title: "legacy", body: "v1 content" }); old.close();
  legacy = startServer({ port: 0, host: "127.0.0.1", token: "synthetic-legacy", autoSync: false });
  const legacyHome = join(directory, "legacy-client");
  await command(legacyHome, ["sync", `http://127.0.0.1:${legacy.port}`, "--token", "synthetic-legacy"]);
  check(JSON.stringify(await command(legacyHome, ["doc", "get", oldDoc.id])).includes("v1 content"), "legacy HTTP compatibility failed");
  checks.push("CLI v1 HTTP compatibility");
  if (process.env.MH_ELECTRON) {
    const harness = join(directory, "electron-harness"); await mkdir(harness);
    await Bun.write(join(harness, "package.json"), JSON.stringify({ name: "mh-bootstrap-test", main: "main.cjs" }));
    await Bun.write(join(harness, "main.cjs"), Bun.file("scripts/fixtures/workspace-bootstrap-electron.cjs"));
    for (const transport of ["http", "bucket"]) {
      const home = join(directory, `electron-${transport}`), profile = join(directory, `profile-${transport}`); await mkdir(profile);
      const source = openMetahub(home);
      if (transport === "http") addPeer(source, { url: httpUrl, token: "synthetic-master" }); else addStoragePeer(source, { url: bucketUrl, config });
      const original = source.filename; source.close();
      for (const restart of [false, true]) {
        const resultPath = join(profile, "result.json"); if (await Bun.file(resultPath).exists()) await Bun.file(resultPath).delete();
        const child = Bun.spawn([process.env.MH_ELECTRON, harness], { env: { ...process.env, METAHUB_HOME: home, MH_TEST_USER_DATA: profile, MH_TEST_IPV6: "1", MH_ACCEPTANCE_DESKTOP: resolve("apps/desktop"), MH_ACCEPTANCE_PEER: transport === "http" ? httpUrl : bucketUrl, MH_ACCEPTANCE_DOCUMENT: doc.id, MH_ACCEPTANCE_RESTART: restart ? "1" : "", BUN_PATH: bunWrapper }, stdout: "pipe", stderr: "pipe" });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 70_000);
        const outputPath = join(directory, `electron-${transport}-${restart}.log`);
        const read = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader(), decoder = new TextDecoder(); let value = "";
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; value += decoder.decode(chunk.value, { stream: true }); await Bun.write(outputPath, value); } }
          finally { reader.releaseLock(); }
          return value;
        };
        try {
          const [exit, stdout, stderr] = await Promise.all([child.exited, read(child.stdout), new Response(child.stderr).text()]);
          await Bun.write(join(directory, `electron-${transport}-${restart}.log`), stdout + stderr);
          const result = await Bun.file(resultPath).json().catch(() => null);
          check(exit === 0 && result?.ok, `Electron ${transport} restart=${restart} failed: ${result?.error ?? stderr.slice(-1500)}`);
          const active = openMetahub(home);
          try { check(active.filename !== original && getDocument(active, doc.id)?.body === "baseline text", "Electron switch not durable"); }
          finally { active.close(); }
        } finally { clearTimeout(timeout); }
      }
      checks.push(`Electron ${transport}: automatic IPC, sidecar stop/start, no upgrade dialog, durable app restart`);
    }
  }
  check(!writes.some(key => /\/(oplog|snapshot|publisher)\//.test(key)), "runtime wrote legacy bucket layout");
  checks.push("No v1 oplog/snapshot/publisher writes");
  const result = { result: "PASS", environment: { platform: process.platform, arch: process.arch, bun: Bun.version, electron: Boolean(process.env.MH_ELECTRON) }, checks, artifacts: directory };
  await Bun.write(join(directory, "report.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await Bun.write(join(directory, "failure.txt"), String(error instanceof Error ? error.stack : error)); console.error(JSON.stringify({ result: "FAIL", artifacts: directory, error: String(error), checks })); process.exitCode = 1;
} finally {
  remote?.stop(); legacy?.stop(); bucketServer.stop(true);
  if (originalHome === undefined) delete process.env.METAHUB_HOME; else process.env.METAHUB_HOME = originalHome;
}
