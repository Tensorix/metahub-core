import { openMetahub } from "../db.ts";
import { getNodeId } from "../node.ts";
import { ingest, changesAfterSeq } from "../crdt.ts";
import { type SyncRequest, SYNC_PATH, HEALTH_PATH } from "./protocol.ts";

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  node: string;
  port: number;
}

/** Start the CRDT sync server. It is just another node backed by ~/.metahub. */
export function startServer(opts: { port?: number } = {}): RunningServer {
  const db = openMetahub();
  const node = getNodeId(db);
  const server = Bun.serve({
    port: opts.port ?? 7777,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === SYNC_PATH) {
        const body = (await req.json()) as SyncRequest;
        ingest(db, body.changes ?? []);
        const batch = changesAfterSeq(db, body.since ?? 0);
        return Response.json({ node_id: node, changes: batch.changes, cursor: batch.cursor });
      }
      if (url.pathname === HEALTH_PATH) return Response.json({ ok: true, node });
      return new Response("not found", { status: 404 });
    },
  });
  return { server, node, port: server.port ?? opts.port ?? 7777 };
}
