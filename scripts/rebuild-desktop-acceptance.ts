/** Exercise the real Electron settings page, IPC and Bun sidecar using an
 * isolated profile, database and local synthetic bucket. */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openMetahub } from "../src/core/db.ts";
import { createDocument, getDocument } from "../src/core/documents.ts";
import { createDraftStore } from "../src/core/replica/drafts.ts";
import { addStoragePeer } from "../src/core/sync/peers.ts";
import { storageUrl } from "../src/core/sync/storage-url.ts";
import { putBlob } from "../src/core/cache.ts";
import { syntheticCheckpoint } from "./fixtures/rebuild-bucket.ts";

const directory = await mkdtemp(join(tmpdir(), "mh-electron-rebuild-"));
const previous = process.env.METAHUB_HOME;
process.env.METAHUB_HOME = join(directory, "home");
const bucket = await syntheticCheckpoint();
const server = Bun.serve({
  hostname: "localhost",
  port: 0,
  fetch: bucket.fetch,
});
const check = (ok: unknown, detail: string) => {
  if (!ok) throw new Error(detail);
};
const source = openMetahub();
const config = {
  endpoint: `http://localhost:${server.port}`,
  region: "test",
  bucket: "synthetic",
  prefix: "fixture",
  encrypt: false,
  accessKeyId: "test",
  secretAccessKey: "test",
};
const peer = storageUrl(config.endpoint, config.bucket, config.prefix);
addStoragePeer(source, { url: peer, config });
const doc = createDocument(source, {
  title: "offline",
  body: "desktop offline text",
});
createDraftStore(source).checkpointDocument(doc.id, {
  revision: 1,
  title: "draft",
  body: "unpublished desktop draft",
  version: null,
});
await putBlob("pending attachment");
const badFile = join(process.env.METAHUB_HOME, "cache", "0".repeat(32));
try {
  const barrier = bucket.holdNextCheckpoint();
  const rebuilding = Bun.spawn(
    [process.execPath, "apps/desktop/src/server-entry.ts", "--rebuild-replica"],
    {
      env: { ...process.env, METAHUB_REBUILD_PEER: peer },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    await Promise.race([
      barrier.started,
      Bun.sleep(8000).then(() => {
        throw new Error("desktop download did not start");
      }),
    ]);
  } finally {
    rebuilding.kill("SIGKILL");
    await rebuilding.exited;
    barrier.release();
  }
  const survived = openMetahub();
  try {
    check(
      survived.filename === source.filename && !!getDocument(survived, doc.id),
      "interrupted rebuild lost source",
    );
  } finally {
    survived.close();
  }
  await Bun.write(badFile, "damaged attachment");
  const desktop = resolve("apps/desktop");
  const harness = join(directory, "harness"),
    profile = join(directory, "profile");
  await mkdir(harness);
  await mkdir(profile);
  await Bun.write(
    join(harness, "package.json"),
    JSON.stringify({ name: "mh-rebuild-test", main: "main.cjs" }),
  );
  await Bun.write(
    join(harness, "main.cjs"),
    Bun.file("scripts/fixtures/rebuild-electron.cjs"),
  );
  const launch = async (restart: boolean) => {
    const resultPath = join(profile, "acceptance-result.json");
    if (await Bun.file(resultPath).exists())
      await Bun.file(resultPath).delete();
    if (!process.env.MH_ELECTRON)
      throw new Error("Set MH_ELECTRON to an Electron executable");
    const child = Bun.spawn([process.env.MH_ELECTRON, harness], {
      env: {
        ...process.env,
        MH_TEST_USER_DATA: profile,
        MH_TEST_IPV6: "1",
        MH_ACCEPTANCE_DESKTOP: desktop,
        MH_ACCEPTANCE_CLOUD_ID: bucket.cloud.id,
        MH_ACCEPTANCE_VERSION: bucket.version,
        MH_ACCEPTANCE_RESTART: restart ? "1" : "",
        BUN_PATH: process.execPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 90_000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (!(await Bun.file(resultPath).exists()))
        throw new Error(
          "Electron acceptance failed: " + out.slice(-2600) + err.slice(-1500),
        );
      const result = await Bun.file(resultPath).json();
      if (!result.ok) throw new Error(result.error + " " + out.slice(-900));
      if (code !== 0) throw new Error("Electron did not exit cleanly: " + code);
    } finally {
      clearTimeout(timeout);
    }
  };
  await launch(false);
  const active = openMetahub();
  try {
    check(
      active.filename !== source.filename,
      "desktop did not select replacement",
    );
    check(
      getDocument(active, bucket.cloud.id)?.body === "cloud checkpoint",
      "desktop checkpoint missing",
    );
    check(
      active
        .query("SELECT 1 FROM documents WHERE body=?")
        .get("unpublished desktop draft"),
      "restored draft missing",
    );
  } finally {
    active.close();
  }
  await launch(true);
  console.log(
    "PASS Electron: settings/IPC, failure restarts original sidecar, durable database switch, draft resolution and app restart",
  );
} finally {
  source.close();
  server.stop(true);
  if (previous === undefined) delete process.env.METAHUB_HOME;
  else process.env.METAHUB_HOME = previous;
  await rm(directory, { recursive: true, force: true });
}
