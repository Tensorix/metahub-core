/** A disposable loopback fixture for actual native network stress. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "../src/core/schema-init.ts";
import { routes } from "../src/core/sync/routes.ts";
import { getNodeId } from "../src/core/node.ts";

export const STRESS_FIXTURE = "metahub-isolated-native-network-v1";
export const STRESS_TOKEN = "native-network-stress-local-only";
type Fault = "none" | "offline" | "lost-response" | "held-response" | "bad-json" | "unauthorized";
export function createReplicaStressServer(port = 0) {
  const folder = mkdtempSync(join(tmpdir(), "mh-native-network-"));
  const db = new Database(join(folder, "relay.db"));
  db.exec("PRAGMA journal_mode=WAL;"); initSchema(db);
  const syncRoute = routes.find(route => route.method === "POST" && route.path === "/sync")!;
  const healthRoute = routes.find(route => route.method === "GET" && route.path === "/health")!;
  const reports = new Map<string, unknown>();
  const faults = new Map<string, Fault>();
  const held = new Map<string, () => void>();
  const stats = new Map<string, { requests: number; uploadedOps: number; maxPage: number; unique: Set<string> }>();
  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== `Bearer ${STRESS_TOKEN}`) return new Response("fixture credentials required", { status: 401 });
    if (url.pathname === "/health" && req.method === "GET") return healthRoute.handler(req, { db, node: getNodeId(db) });
    if (url.pathname === "/fixture" && req.method === "GET") return Response.json({ fixture: STRESS_FIXTURE, isolated: true });
    if (url.pathname === "/fixture/reports" && req.method === "GET") return Response.json(Object.fromEntries(reports));
    if (url.pathname === "/fixture/reports" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 128_000) return new Response("report too large", { status: 413 });
      let body: { kind?: string; report?: { environment?: { platform?: string; artifactClass?: string } } };
      try { body = JSON.parse(text); } catch { return new Response("invalid report", { status: 400 }); }
      const platform = body.report?.environment?.platform;
      if (!["ios", "android"].includes(platform ?? "") || !["network", "performance", "driver"].includes(body.kind ?? "") || body.report?.environment?.artifactClass !== "synthetic-native-diagnostics") return new Response("synthetic report required", { status: 400 });
      reports.set(platform + "-" + body.kind, body.report);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/fault" && req.method === "POST") {
      const body = await req.json() as { node: string; mode: Fault };
      if (!["none", "offline", "lost-response", "held-response", "bad-json", "unauthorized"].includes(body.mode) || typeof body.node !== "string") return new Response("bad fixture fault", { status: 400 });
      faults.set(body.node, body.mode);
      if (body.mode === "none") { held.get(body.node)?.(); held.delete(body.node); }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/fixture/stats") {
      const node = url.searchParams.get("node") ?? "";
      const s = stats.get(node);
      const table = url.searchParams.get("database");
      const records = (db.query("SELECT count(*) AS n FROM records WHERE database_id=? AND __deleted=0").get(table) as { n: number }).n;
      return Response.json({ fixture: STRESS_FIXTURE, waiting: held.has(node), requests: s?.requests ?? 0, uploadedOps: s?.uploadedOps ?? 0, uniqueUploadedOps: s?.unique.size ?? 0, maxUploadedPage: s?.maxPage ?? 0, records });
    }
    if (url.pathname !== "/sync" || req.method !== "POST") return new Response("not found", { status: 404 });
    const body = await req.clone().json() as { node_id: string; changes: import("../src/core/crdt.ts").Change[] };
    const mode = faults.get(body.node_id) ?? "none";
    if (mode === "offline") return new Response("fixture offline", { status: 503 });
    if (mode === "unauthorized") return new Response("fixture revoked", { status: 401 });
    const s = stats.get(body.node_id) ?? { requests: 0, uploadedOps: 0, maxPage: 0, unique: new Set<string>() };
    s.requests++; s.uploadedOps += body.changes.length; s.maxPage = Math.max(s.maxPage, body.changes.length);
    for (const c of body.changes) s.unique.add(`${c.hlc}/${c.node_id}/${c.dataset}/${c.row_id}/${c.col}`);
    stats.set(body.node_id, s);
    const response = await syncRoute.handler(req, { db, node: getNodeId(db) });
    if (mode === "lost-response" || mode === "bad-json") {
      faults.set(body.node_id, "none");
      return mode === "lost-response" ? new Response("fixture lost ack after remote commit", { status: 503 }) : new Response("{");
    }
    if (mode === "held-response") await new Promise<void>(resolve => held.set(body.node_id, resolve));
    return response;
  } });
  return {
    url: `http://127.0.0.1:${server.port}`, port: server.port,
    async stop() {
      for (const release of held.values()) release(); held.clear();
      await server.stop(true); db.close(); rmSync(folder, { recursive: true, force: true });
    },
  };
}
if (import.meta.main) {
  const fixture = createReplicaStressServer(8992);
  console.log(JSON.stringify({ fixture: STRESS_FIXTURE, url: fixture.url, isolated: true, android: "adb reverse tcp:8992 tcp:8992" }));
  process.once("SIGINT", () => { void fixture.stop().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void fixture.stop().then(() => process.exit(0)); });
}
