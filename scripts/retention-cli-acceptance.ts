import { recoveryItems } from "../src/core/sync/recovery-v2.ts";
/** Explicit live test against an already-authorized synthetic fixture. Secrets
 * remain in its ignored private directory; no remote DELETE is performed. */
import { Database } from "bun:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initSchema } from "../src/core/schema-init.ts";
import { createDocument, getDocument } from "../src/core/documents.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "../src/core/sync/current-checkpoint.ts";
import { createV2Bucket } from "../src/core/sync/bucket-v2.ts";
import { createFetchStorageClient } from "../src/core/sync/storage-s3-fetch.ts";
import { writeReplicaGeneration } from "../src/core/sync/retention-protocol.ts";
import { addStoragePeer } from "../src/core/sync/peers.ts";
import { storageUrl } from "../src/core/sync/storage-url.ts";
import { assertFixtureIdentity, type Manifest } from "../apps/mobile/scripts/acceptance-fixture.ts";
import type { S3Config, StorageClient } from "../src/core/sync/storage.ts";

process.umask(0o077);
const directory = resolve(process.argv[2] ?? "");
const privateRoot = resolve(import.meta.dir, "../apps/mobile/dist/acceptance/private");
if (!directory.startsWith(privateRoot + "/")) throw new Error("An owned private fixture directory is required");
const runId = crypto.randomUUID(), runDirectory = join(directory, `core-cli-${runId}`);
await mkdir(runDirectory, { mode: 0o700 });
let stage = "validate-fixture";
try {
  const owner: Manifest = await Bun.file(join(directory, "fixture-owner.json")).json();
  const parent: S3Config = await Bun.file(join(directory, "bucket-config.json")).json();
  assertFixtureIdentity(parent, owner);
  const config = { ...parent, prefix: `${parent.prefix}/core-cli-${runId}`, publish: false };
  const raw = createFetchStorageClient(config), requests = { reads: 0, writes: 0, conditions: 0 };
  const allowed = (key: string) => { if (!key.startsWith(config.prefix + "/") || key.split("/").includes("..")) throw new Error("Object escaped isolated prefix"); };
  const client: StorageClient = {
    conditionalCreateCapability: raw.conditionalCreateCapability,
    getWithMetadata: async (key, options) => { allowed(key); requests.reads++; return raw.getWithMetadata!(key, options); },
    get: async (key, options) => { allowed(key); requests.reads++; return raw.get(key, options); },
    list: async () => { throw new Error("Live v2 acceptance must not depend on LIST"); },
    put: async (key, bytes, options) => { allowed(key); requests.writes++; if (options?.ifNoneMatch) requests.conditions++; return raw.put(key, bytes, options); },
    del: async () => { throw new Error("Remote deletion forbidden in this acceptance run"); },
  };
  stage = "conditional-create-capability";
  if (!await client.conditionalCreateCapability!()) throw new Error("Atomic conditional creation unavailable");
  const homes = [join(runDirectory, "a"), join(runDirectory, "b")];
  for (const home of homes) await mkdir(home, { mode: 0o700 });
  const a = new Database(join(homes[0]!, "metahub.db")), b = new Database(join(homes[1]!, "metahub.db"));
  initSchema(a); initSchema(b);
  const doc = createDocument(a, { title: "V2 CLI synthetic", body: "baseline text" });
  const initialBlocks = JSON.stringify(a.query("SELECT id FROM doc_blocks WHERE doc_id=? ORDER BY id").all(doc.id));
  const checkpoint = captureCurrentCheckpoint(a, runId, 0), bucket = createV2Bucket(client, config);
  stage = "concurrent-initialization";
  const roots = await Promise.all([bucket.initialize(checkpoint), bucket.initialize(checkpoint)]);
  if (roots[0]!.checkpoint !== roots[1]!.checkpoint) throw new Error("Initialization did not converge");
  installCurrentCheckpoint(b, await bucket.checkpointFor(roots[0]!, roots[0]!.checkpoint, 0), runId);
  for (const [db, incarnationId] of [[a, "cli-a"], [b, "cli-b"]] as const) {
    writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: runId, epoch: 0, checkpoint: roots[0]!.checkpoint, incarnationId });
    addStoragePeer(db, { url: storageUrl(config.endpoint, config.bucket, config.prefix), config });
  }
  a.close(); b.close();
  const cli = resolve(import.meta.dir, "../src/cli/index.ts");
  async function command(home: string, args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
      env: { ...process.env, METAHUB_HOME: home, MH_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await Bun.write(join(runDirectory, `${stage}.json`), JSON.stringify({ exit, stdout, stderr }));
    if (exit !== (stage === "cli-obsolete-checkpoint" ? 12 : 0)) throw new Error(`CLI failed at ${stage}; see private run evidence`);
    return JSON.parse(stdout);
  }
  stage = "cli-sync-a"; await command(homes[0]!, ["sync"]);
  stage = "cli-sync-b"; await command(homes[1]!, ["sync"]);
  stage = "cli-edit-a"; await command(homes[0]!, ["doc", "edit", doc.id, "--old", "baseline", "--new", "CLI verified"]);
  stage = "cli-push-edit"; await command(homes[0]!, ["sync"]);
  stage = "cli-pull-edit"; await command(homes[1]!, ["sync"]);
  stage = "cli-get-b"; const read = await command(homes[1]!, ["doc", "get", doc.id]);
  if (!JSON.stringify(read).includes("CLI verified text")) throw new Error("CLI replica body did not converge");
  stage = "reopen-verification";
  const reopened = new Database(join(homes[1]!, "metahub.db"), { readonly: true });
  try { if (getDocument(reopened, doc.id)?.body !== "CLI verified text") throw new Error("Reopened database lost content"); }
  finally { reopened.close(); }
  stage = "cli-left-concurrent"; await command(homes[0]!, ["doc", "edit", doc.id, "--old", "CLI verified", "--new", "left concurrent"]);
  stage = "cli-right-concurrent"; await command(homes[1]!, ["doc", "edit", doc.id, "--old", "CLI verified", "--new", "right concurrent"]);
  stage = "cli-left-push"; await command(homes[0]!, ["sync"]);
  stage = "cli-right-merge"; await command(homes[1]!, ["sync"]);
  stage = "cli-left-merge"; await command(homes[0]!, ["sync"]);
  for (const home of homes) {
    const replica = new Database(join(home, "metahub.db"));
    try {
      if (JSON.stringify(replica.query("SELECT id FROM doc_blocks WHERE doc_id=? ORDER BY id").all(doc.id)) !== initialBlocks) throw new Error("CLI edits replaced stable block identity");
      const preserved = JSON.stringify(recoveryItems(replica)) + getDocument(replica, doc.id)!.body;
      if (!preserved.includes("left concurrent text") || !preserved.includes("right concurrent text")) throw new Error("CLI concurrent content was lost");
    } finally { replica.close(); }
  }
  stage = "cli-retention-report";
  const retention = await command(homes[0]!, ["recovery", "report"]);
  if (retention.workspaceId !== runId || retention.checkpoint !== roots[0]!.checkpoint || retention.candidates.length)
    throw new Error("CLI retention report did not match the synthetic workspace");
  stage = "cli-recovery-list";
  if (!(await command(homes[0]!, ["recovery", "list"])).length) throw new Error("CLI recovery did not expose the preserved conflict");
  const before = await bucket.log(roots[0]!).read();
  const stale = new Database(join(homes[1]!, "metahub.db"));
  const saved = (stale.query("SELECT value FROM meta WHERE key='sync_v2_generation'").get() as { value: string }).value;
  stale.query("UPDATE meta SET value=? WHERE key='sync_v2_generation'").run(JSON.stringify({ ...JSON.parse(saved), checkpoint: "0".repeat(64) }));
  stale.close();
  try {
    stage = "cli-obsolete-checkpoint";
    const rejected = await command(homes[1]!, ["sync"]);
    if (rejected[0]?.code !== "rebootstrap_required") throw new Error("CLI lost structured protocol error");
    if ((await bucket.log(roots[0]!).read()).sequence !== before.sequence) throw new Error("Obsolete CLI wrote a control record");
  } finally {
    const restored = new Database(join(homes[1]!, "metahub.db"));
    restored.query("UPDATE meta SET value=? WHERE key='sync_v2_generation'").run(saved); restored.close();
  }
  const report = { status: "passed", fixtureId: owner.id, runId, tests: ["COS metadata and conditional-create capability", "concurrent initialization", "CLI two-replica sync", "CLI edit-push-pull-read", "SQLite reopen durability", "stable block identity through CLI edits", "CLI same-block conflict preservation", "obsolete checkpoint rejects before upload with exit 12", "CLI read-only retention report", "CLI recovery conflict list"], setupRequests: requests, remoteDeletes: 0 };
  await Bun.write(join(runDirectory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const details = join(runDirectory, "failure-private.json");
  await Bun.write(details, JSON.stringify({ stage, message: String(error), stack: error instanceof Error ? error.stack : null }));
  await chmod(details, 0o600);
  console.error(JSON.stringify({ status: "failed", stage, runId, privateEvidence: runDirectory }));
  process.exitCode = 1;
}
