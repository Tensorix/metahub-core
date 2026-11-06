import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init.ts";
import { createDocument, getDocument, updateDocument } from "../documents.ts";
import { getNodeId } from "../node.ts";
import { addPeer, getPeer } from "./peers.ts";
import { writeReplicaGeneration } from "./retention-protocol.ts";
import { recoverConnectedWorkspace } from "./workspace-recovery.ts";
import { routes } from "./routes.ts";
import { workspaceAccess } from "./workspace-access.ts";

test("HTTP recovery into a native-style empty shadow resumes from the captured snapshot cursor", async () => {
  const server = new Database(":memory:"), source = new Database(":memory:");
  let shadow: Database | undefined;
  let sourceClosed = false;
  initSchema(server); initSchema(source);
  const doc = createDocument(server, { title: "snapshot", body: "before capture" });
  writeReplicaGeneration(server, { protocolVersion: 2, workspaceId: "native-cursor", epoch: 0, checkpoint: "a".repeat(64), incarnationId: "server" });
  const url = "http://fixture.invalid";
  addPeer(source, { url });
  let capturedCursor = -1;
  const requestedCursors: number[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (path === "/sync") requestedCursors.push((await request.clone().json()).since);
    const route = routes.find(r => r.path === path && r.method === request.method)!;
    const response = await route.handler(request, { db: server, node: getNodeId(server) });
    if (path === "/sync/bootstrap") {
      capturedCursor = (await response.clone().json()).snapshot.cursor;
      updateDocument(server, doc.id, { body: "edit during download" });
    }
    return response;
  }) as typeof fetch;
  try {
    await recoverConnectedWorkspace(source, { kind: "http", url, fetch: transport }, {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "test-protection" }),
      // Native credentials are in SecureStore: the new database has no peers.
      createShadow: async () => { shadow = new Database(":memory:"); initSchema(shadow); return shadow; },
      swap: async () => {}, releaseShadow: async () => {},
      resume: async () => {
        expect(source.query("SELECT 1 FROM meta WHERE key='sync_workspace_initializing'").get()).toBeNull();
        source.close(); sourceClosed = true;
      },
    }, true);
    expect(capturedCursor).toBeGreaterThan(0);
    expect(requestedCursors[0]).toBe(capturedCursor);
    expect(getPeer(shadow!, url)?.pull_cursor).toBeGreaterThan(capturedCursor);
    expect(getDocument(shadow!, doc.id)?.body).toBe("edit during download");
  } finally { shadow?.close(); if (!sourceClosed) source.close(); server.close(); }
});

test("HTTP bootstrap failure records retry state before a native host closes the source", async () => {
  const server = new Database(":memory:"), source = new Database(":memory:");
  initSchema(server); initSchema(source);
  writeReplicaGeneration(server, { protocolVersion: 2, workspaceId: "native-failure", epoch: 0, checkpoint: "b".repeat(64), incarnationId: "server" });
  const url = "http://fixture.invalid";
  addPeer(source, { url });
  let sourceClosed = false;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (path === "/sync/bootstrap") throw new Error("download interrupted");
    const route = routes.find(r => r.path === path && r.method === request.method)!;
    return route.handler(request, { db: server, node: getNodeId(server) });
  }) as typeof fetch;
  try {
    await expect(recoverConnectedWorkspace(source, { kind: "http", url, fetch: transport }, {
      pauseAndFlush: async () => {}, protect: async () => ({ proof: "test-protection" }),
      createShadow: async () => { throw new Error("must not install a partial download"); },
      swap: async () => { throw new Error("must not switch after failure"); }, releaseShadow: async () => {},
      resume: async () => {
        expect(workspaceAccess(source)[0]).toMatchObject({ kind: "error", reason: "download interrupted" });
        expect(source.query("SELECT 1 FROM meta WHERE key='sync_workspace_initializing'").get()).toBeNull();
        expect(source.query("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 0 });
        source.close(); sourceClosed = true;
      },
    }, true)).rejects.toThrow("download interrupted");
    expect(sourceClosed).toBe(true);
  } finally { if (!sourceClosed) source.close(); server.close(); }
});
