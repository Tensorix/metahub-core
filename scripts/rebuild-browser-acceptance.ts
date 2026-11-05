/** Start a local synthetic S3 endpoint and use real Chromium OPFS and IndexedDB.
 * Provide a Playwright module and Chrome executable from the test environment. */
import { syntheticCheckpoint } from "./fixtures/rebuild-bucket.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "mh-rebuild-browser-"));
const bucket = await syntheticCheckpoint();
const { cloud } = bucket;
const check = (ok: unknown, detail: string) => {
  if (!ok) throw new Error(detail);
};
const bundles = await Bun.build({
  entrypoints: [
    "scripts/fixtures/rebuild-page.tsx",
    "src/webui/data/db-worker.ts",
    "src/webui/app.tsx",
  ],
  outdir: directory,
  target: "browser",
  format: "esm",
  naming: "[name].js",
});
if (!bundles.success) throw new Error(bundles.logs.join("\n"));
const server = Bun.serve({
  hostname: "localhost",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/")
      return new Response(
        '<html><body><div id="app"></div><script type="module" src="/rebuild-page.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/app")
      return new Response(
        '<html><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    if (
      path === "/app.js" ||
      path === "/db-worker.js" ||
      path === "/rebuild-page.js"
    )
      return new Response(Bun.file(join(directory, path.slice(1))));
    if (path === "/sqlite3.wasm")
      return new Response(
        Bun.file("node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
        { headers: { "content-type": "application/wasm" } },
      );
    return bucket.fetch(req);
  },
});
let context;
try {
  const { chromium } = await import(
    process.env.MH_PLAYWRIGHT_MODULE || "playwright"
  );
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    executablePath: process.env.MH_CHROME,
    headless: true,
    locale: "zh-CN",
  });
  const url = `http://localhost:${server.port}`;
  let page = await context.newPage();
  page.on("pageerror", (error: Error) => console.error(error.message));
  await page.goto(url);
  const initialId = await page.evaluate(() =>
    (window as any).acceptance.seed(),
  );
  const trigger = async () => {
    await page.getByRole("button", { name: "保全编辑并重建本地副本" }).click();
    await page.getByRole("button", { name: "开始重建" }).click();
  };
  await page.evaluate(() => (window as any).acceptance.refuseSave(true));
  await trigger();
  await page.getByRole("status").filter({ hasText:"编辑器拒绝保存" }).waitFor();
  check(await page.evaluate(() => !document.getElementById("app")?.hasAttribute("inert")),"failed flush left input frozen");
  await page.evaluate(() => (window as any).acceptance.refuseSave(false));
  const second = await context.newPage();
  await second.goto(url);
  await second.evaluate(() => (window as any).acceptance.call("status"));
  await trigger();
  await page.getByRole("status").filter({ hasText: "其他标签页" }).waitFor();
  await second.close();
  await page.evaluate(() => (window as any).acceptance.spool(true));
  await trigger();
  await page.getByRole("status").filter({ hasText: "附件校验失败" }).waitFor();
  check(
    (
      await page.evaluate(
        (id: string) => (window as any).acceptance.call("getDocument", id),
        initialId,
      )
    ).body === "pending local text",
    "source lost on failure",
  );
  const hash = await page.evaluate(() =>
    (window as any).acceptance.spool(false),
  );
  const interrupted = bucket.holdNextCheckpoint();
  await trigger();
  await Promise.race([
    interrupted.started,
    Bun.sleep(8000).then(() => {
      throw new Error("checkpoint download did not start");
    }),
  ]);
  await page.close();
  interrupted.release();
  page = await context.newPage();
  await page.goto(url);
  check(
    (
      await page.evaluate(
        (id: string) => (window as any).acceptance.call("getDocument", id),
        initialId,
      )
    ).body === "pending local text",
    "interrupted worker replaced source",
  );
  // Enter through the production static app's first hydration gate. This
  // replica has no prior successful cloud round, so settings alone are insufficient.
  await page.evaluate(() => {
    localStorage.setItem("mh_replica", "1");
    localStorage.setItem("mh_origin_mode", "none");
    localStorage.removeItem("mh_replica_hydrated");
  });
  await page.goto(url + "/app#/settings?sec=backup");
  await trigger();
  await page.waitForFunction(
    () => localStorage.getItem("mh_replica_hydrated") === "1",
  );
  await page
    .locator("details")
    .filter({ hasText: "pending local text" })
    .first()
    .waitFor({ state: "attached" });
  await page.goto(url);
  const restored = await page.evaluate(
    (id: string) => (window as any).acceptance.call("getDocument", id),
    cloud.id,
  );
  check(
    restored.body === "cloud checkpoint",
    "worker restart did not select the published database",
  );
  check(bucket.history.reads === 0, "bootstrap eagerly downloaded history");
  const history = () =>
    page.evaluate(
      ({ id, version }: { id: string; version: string }) =>
        (window as any).acceptance.call("documentAtVersion", id, version),
      { id: cloud.id, version: bucket.version },
    );
  bucket.history.available = false;
  let unavailable = false;
  try {
    await history();
  } catch (error) {
    unavailable = String(error).includes("历史尚未下载");
  }
  check(unavailable, "missing history was not reported");
  bucket.history.available = true;
  check(
    (await history()).body === "cloud history",
    "retained history unavailable after rebuild",
  );
  bucket.history.available = false;
  check(
    (await history()).body === "cloud history",
    "downloaded history unavailable offline",
  );
  const item = page
    .locator("details")
    .filter({ hasText: "pending local text" });
  await item.locator("summary").click();
  await item.getByRole("button", { name: "创建恢复副本" }).click();
  await item.waitFor({ state: "detached" });
  check(
    await page.evaluate(
      async (key: string) => !!(await (window as any).acceptance.spoolGet(key)),
      hash,
    ),
    "spooled bytes missing after restart",
  );
  console.log(
    "PASS Chromium: multi-tab exclusion, failed attachment protection keeps source, OPFS swap, worker restart, attachment spool and recovery item UI",
  );
} finally {
  await context?.close();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
