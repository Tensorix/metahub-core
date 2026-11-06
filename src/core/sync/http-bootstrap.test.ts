import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMetahub } from "../db.ts";
import { createDocument } from "../documents.ts";
import { writeReplicaGeneration } from "./retention-protocol.ts";
import { startServer } from "./server.ts";

test("HTTP bootstrap requires a sync credential, accepts pairing grants and is never cached", async () => {
  const home = await mkdtemp(join(tmpdir(), "mh-bootstrap-auth-")), previous = process.env.METAHUB_HOME;
  process.env.METAHUB_HOME = home;
  let running: ReturnType<typeof startServer> | undefined;
  try {
    const db = openMetahub();
    createDocument(db, { title: "authenticated snapshot", body: "content" });
    writeReplicaGeneration(db, { protocolVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: "a".repeat(64), incarnationId: "server" });
    db.query("INSERT INTO peer_grants(token,node_id) VALUES('paired-secret','paired-device')").run(); db.close();
    running = startServer({ port: 0, host: "127.0.0.1", token: "master-secret", autoSync: false });
    const url = `http://127.0.0.1:${running.port}`;
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ minSupportedDataVersion: 1, maxSupportedDataVersion: 2, workspaceId: "workspace", epoch: 0, checkpoint: "a".repeat(64) }) };
    expect((await fetch(url + "/sync/bootstrap", request)).status).toBe(401);
    for (const token of ["master-secret", "paired-secret"]) {
      const response = await fetch(url + "/sync/bootstrap", { ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json(); expect(payload.snapshot.current.workspaceId).toBe("workspace"); expect(payload.sha256).toHaveLength(64);
    }
    const health = await (await fetch(url + "/health")).json(); expect(health.capabilities).toContain("sync_bootstrap_v1");
  } finally { running?.stop(); if (previous === undefined) delete process.env.METAHUB_HOME; else process.env.METAHUB_HOME = previous; await rm(home, { recursive: true, force: true }); }
});
