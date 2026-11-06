/** Real Chromium/OPFS acceptance against a disposable synthetic bucket.
 * MH_PLAYWRIGHT_MODULE and MH_CHROME select an existing local browser runtime. */
import { syntheticCheckpoint } from "./fixtures/rebuild-bucket.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.MH_PLAYWRIGHT_MODULE || "playwright");
const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "mh-bootstrap-chromium-"));
const bucket = await syntheticCheckpoint();
const writes = new Map<string, { bytes: Uint8Array; at: number }>();
const built = await Bun.build({
  entrypoints: ["scripts/fixtures/workspace-bootstrap-page.tsx", "scripts/fixtures/workspace-bootstrap-worker.ts"],
  outdir: directory, target: "browser", format: "esm", naming: "[name].js",
});
if (!built.success) throw new Error(built.logs.join("\n"));
const server = Bun.serve({ hostname: "localhost", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/") return new Response(`<html><body><div id="app"></div><script>localStorage.setItem('mh_origin_mode','none');localStorage.setItem('mh_replica','1')</script><script type="module" src="/workspace-bootstrap-page.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
  if (path === "/db-worker.js") return new Response(Bun.file(join(directory, "workspace-bootstrap-worker.js")));
  if (path.endsWith(".js")) return new Response(Bun.file(join(directory, path.slice(1))));
  if (path === "/sqlite3.wasm") return new Response(Bun.file(join(root, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm")), { headers: { "content-type": "application/wasm" } });
  if (req.method === "PUT" && path.startsWith("/synthetic/")) {
    if (req.headers.get("if-none-match") === "*" && writes.has(path)) return new Response("occupied", { status: 412 });
    writes.set(path, { bytes: new Uint8Array(await req.arrayBuffer()), at: Date.now() }); return new Response(null);
  }
  const object = writes.get(path);
  if (object && req.method === "GET") return new Response(object.bytes, { headers: { date: new Date().toUTCString(), "last-modified": new Date(object.at).toUTCString() } });
  return bucket.fetch(req);
} });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.MH_CHROME, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => console.error(error.message));
  const origin = `http://localhost:${server.port}`;
  await page.goto(origin);
  await page.waitForFunction(() => !!(window as any).acceptance);
  await page.evaluate(() => (window as any).acceptance.call("status"));
  const follower = await context.newPage();
  await follower.goto(origin);
  await follower.waitForFunction(() => !!(window as any).acceptance);
  await follower.evaluate(() => (window as any).acceptance.call("status"));
  await page.evaluate(() => (window as any).acceptance.connect());
  await page.waitForFunction(() => (window as any).acceptance.replicaStatus().workspaceAccess?.some((state: any) => state.kind === "ready"), null, { timeout: 25_000 });
  for (const tab of [page, follower]) {
    const doc = await tab.evaluate((id: string) => (window as any).acceptance.call("getDocument", id), bucket.cloud.id);
    if (doc.body !== "cloud checkpoint") throw new Error("Remote content differs");
    if (await tab.locator("dialog").count()) throw new Error("Fresh install displayed an upgrade dialog");
  }
  const uploaded = await page.evaluate(async () => { await (window as any).acceptance.call("createDocument", { title: "new browser edit", body: "after initialization" }); return await (window as any).acceptance.call("sync"); });
  if (!uploaded?.ok) throw new Error("Upload failed: " + JSON.stringify(uploaded));
  if (![...writes.keys()].some(key => key.includes("/v2/control/"))) throw new Error("No v2 upload after initialization");
  if ([...writes.keys()].some(key => /\/(oplog|snapshot|publisher)\//.test(key))) throw new Error("Unexpected legacy write");
  await page.reload();
  await page.waitForFunction(() => !!(window as any).acceptance);
  const reopened = await page.evaluate((id: string) => (window as any).acceptance.call("getDocument", id), bucket.cloud.id);
  if (reopened.body !== "cloud checkpoint") throw new Error("Reopen lost the selected replica");
  await page.screenshot({ path: join(directory, "fresh-workspace.png") });
  console.log(JSON.stringify({ result: "PASS", freshBucket: true, multipleTabs: true, v2Upload: true, reopen: true, upgradeDialogs: 0, artifacts: directory }));
} finally { await browser?.close(); server.stop(true); }
