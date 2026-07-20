// Stage C2 e2e: the full owner/CLI-side room chain against an in-process room
// HOST — a Bun.serve wrapper around the SAME portable handlers the Durable
// Object shell runs (createRoomFetch / roomWsSession / roomWsMessage over
// bun:sqlite instead of DoSqlDriver; workerd itself cannot run under bun test,
// see test/workerd/ for the driver contract).
//
// Flow under test: share create --room's core path (createShareAction →
// provisionRoomForShare, mock edge config pointing at this host) → first seed
// → device edits flowing on tick rounds (syncPeer's kind='room' branch) →
// guest unlock + REST/WS writes → owner pull-back → blob channel → revoke
// destroying the room.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import { createRecord, updateRecord, listRecords } from "../records.ts";
import { createSite, putFileInline, writeFileRow } from "../sites-core.ts";
import { serializeGrantSet } from "../grants-core.ts";
import { getShare, listShares } from "../shares.ts";
import { setEdgeConfig } from "./edge-config.ts";
import { getPeer, listPeers, syncPeer } from "./peers.ts";
import { createShareAction, revokeShareAction } from "./share-actions.ts";
import {
  pushRoomBlobs,
  roomPeerKey,
  roomTransport,
} from "./room-peer.ts";
import { ROOM_PROTOCOL_VERSION } from "./room-protocol.ts";
import { createRoomFetch, roomWsSession, roomWsMessage } from "./room-serve.ts";
import type { RoomPeerConfig } from "./peers.ts";

const OWNER_TOKEN = "drt_test-secret";

function makeHub(node: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(node);
  return db;
}

/** In-process room host: one bun:sqlite database per slug behind the portable
 *  room fetch handler, plus Bun.serve's pubsub as the WS poke fan-out. */
function startRoomHost() {
  const rooms = new Map<string, Database>();
  const dbFor = (slug: string): Database => {
    let d = rooms.get(slug);
    if (!d) {
      d = new Database(":memory:");
      rooms.set(slug, d);
    }
    return d;
  };

  type WsData = { slug: string; sub: string };
  const server = Bun.serve<WsData>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const m = /^\/r\/([^/]+)/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const slug = decodeURIComponent(m[1]!);
      const db = dbFor(slug);
      // Intercept /ws only for a REAL websocket handshake — a plain GET falls
      // through to the portable handler (426 live / 404 dead), the same
      // routing the DO shell (workers/room.ts) uses so the SDK liveness probe
      // behaves identically on both runtimes.
      if (
        url.pathname === `/r/${m[1]}/ws` &&
        (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
      ) {
        const sess = await roomWsSession(db, req);
        if (!sess) return new Response("not found", { status: 404 });
        if (srv.upgrade(req, { data: { slug, sub: sess.sub } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      const handler = createRoomFetch({
        db,
        ownerToken: OWNER_TOKEN,
        poke: (seq) => srv.publish(`room:${slug}`, JSON.stringify({ type: "poke", seq })),
        destroy: () => {
          // Physical wipe — the DO shell's storage.deleteAll analogue.
          rooms.set(slug, new Database(":memory:"));
        },
      });
      return handler(req);
    },
    websocket: {
      open(ws) {
        ws.subscribe(`room:${ws.data.slug}`);
      },
      async message(ws, message) {
        const out = await roomWsMessage(dbFor(ws.data.slug), ws.data.sub, String(message));
        if (out.reply) ws.send(out.reply);
        if (out.poke)
          server.publish(`room:${ws.data.slug}`, JSON.stringify({ type: "poke", seq: out.seq }));
      },
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    dbFor,
    stop: () => server.stop(true),
  };
}

function cookieOf(res: Response): string {
  const c = res.headers.get("set-cookie") ?? "";
  return c.split(";")[0] ?? "";
}

test("room e2e: create --room path → seed → tick → guest unlock/write → pull-back → revoke destroys", async () => {
  const host = startRoomHost();
  try {
    // ---- owner hub with a site + granted table, edge config → the host ------
    const A = makeHub("nodeA");
    setEdgeConfig(A, { endpoint: host.url, token: OWNER_TOKEN });
    const X = createDatabase(A, { name: "tasks" }).id;
    const title = addProperty(A, X, { name: "title", type: "text" });
    const siteId = createSite(A, { name: "board" }).id;
    putFileInline(A, siteId, "index.html", { data: "<h1>board</h1>" });
    const r1 = createRecord(A, X, { title: "hello" });

    // ---- the `mh share create <site> --grant tasks:… --password --room` core path
    const created = await createShareAction(A, {
      kind: "site",
      ref: "board",
      transport: "server",
      hosting: "room",
      password: "sesame",
      grants: serializeGrantSet({ v: 1, tables: [{ db: X, ops: ["read", "create", "update"] }] }),
    });
    const share = getShare(A, created.slug)!;
    expect(created.hosting).toBe("room");
    expect(created.url).toBe(`${host.url}/r/${share.slug}/`);
    expect(getPeer(A, roomPeerKey(share.slug))?.kind).toBe("room");
    const room = { url: created.url };

    // Seed landed: the room's own db holds the pushed record.
    const roomDb = host.dbFor(share.slug);
    expect(
      roomDb.query("SELECT COUNT(*) AS n FROM records WHERE database_id = ?").get(X),
    ).toEqual({ n: 1 });

    // ---- guest face: locked site → unlock → serve --------------------------
    const noSession = await fetch(room.url, { headers: { accept: "text/html" } });
    expect(noSession.status).toBe(200);
    expect(await noSession.text()).toContain("口令");
    const badPw = await fetch(`${room.url}unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badPw.status).toBe(401);
    const unlocked = await fetch(`${room.url}unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "sesame" }),
      redirect: "manual",
    });
    expect(unlocked.status).toBe(303);
    const cookie = cookieOf(unlocked);
    expect(cookie).toContain(`mh_room_${share.slug}=`);
    const page = await fetch(room.url, { headers: { cookie, accept: "text/html" } });
    expect(await page.text()).toBe("<h1>board</h1>");

    // Anti-enumeration: an unprovisioned slug 404s uniformly.
    expect((await fetch(`${host.url}/r/nosuchroom/`, { headers: { accept: "text/html" } })).status).toBe(404);

    // SDK liveness-probe contract (client.ts terminal detection keys on this):
    // a plain GET on /ws answers 426 for a LIVE room — session-independent, so
    // a locked room still probes alive — and a bare 404 for a dead slug.
    expect((await fetch(`${host.url}/r/${share.slug}/ws`)).status).toBe(426);
    expect((await fetch(`${host.url}/r/nosuchroom/ws`)).status).toBe(404);

    // ---- granted API: read + guest write ------------------------------------
    const rows = (await (
      await fetch(`${room.url}api/records?db=tasks`, { headers: { cookie } })
    ).json()) as { id: string; cells: Record<string, unknown> }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.cells[title.id]).toBe("hello");

    const guestWrite = await fetch(`${room.url}api/records?db=tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "from guest" }),
    });
    expect(guestWrite.status).toBe(200);

    // Guest ops are attributed to a per-visitor sub of the share's guest base.
    const guestBase = share.guest_node_id!;
    const authors = roomDb
      .query("SELECT DISTINCT node_id FROM crdt_changes WHERE node_id LIKE ? || '-%'")
      .all(guestBase) as { node_id: string }[];
    expect(authors.length).toBe(1);

    // ---- WS: poke on owner sync + write intents ------------------------------
    const ws = new WebSocket(`ws://127.0.0.1:${host.server.port}/r/${share.slug}/ws`, {
      headers: { cookie },
    } as unknown as string[]);
    const messages: string[] = [];
    const nextMessage = () =>
      new Promise<{ type?: string; seq?: number; record?: { id: string } }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws message timeout")), 3000);
        ws.addEventListener(
          "message",
          (ev) => {
            clearTimeout(t);
            messages.push(String(ev.data));
            resolve(JSON.parse(String(ev.data)));
          },
          { once: true },
        );
      });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
    });

    // Device edit → tick round (peers.ts kind='room' branch) → poke reaches guests.
    updateRecord(A, r1.id, { title: "hello v2" });
    const pokeP = nextMessage();
    const tick1 = await syncPeer(A, roomPeerKey(share.slug));
    expect(tick1.ok).toBe(true);
    expect((await pokeP).type).toBe("poke");
    const after = (await (
      await fetch(`${room.url}api/record?id=${r1.id}`, { headers: { cookie } })
    ).json()) as { cells: Record<string, unknown> };
    expect(after.cells[title.id]).toBe("hello v2");

    // WS write intent (P2): applied with the room's clock, answered inline.
    const resultP = nextMessage();
    ws.send(
      JSON.stringify({
        type: "write",
        id: 7,
        intent: { op: "createRecord", db: "tasks", values: { title: "via ws" } },
      }),
    );
    const wsResult = (await resultP) as { type: string; id: number; record: { id: string } };
    expect(wsResult.type).toBe("result");
    expect(wsResult.id).toBe(7);

    // ---- owner pull-back: both guest writes flow home ------------------------
    const tick2 = await syncPeer(A, roomPeerKey(share.slug));
    expect(tick2.ok).toBe(true);
    const titles = listRecords(A, X).map((r) => r.cells[title.id]);
    expect(titles).toContain("from guest");
    expect(titles).toContain("via ws");

    // ---- blob channel: need_blobs → chunked push → served bytes --------------
    const hash = "ab".repeat(16); // 32-hex "hash" of the fake blob
    writeFileRow(A, siteId, "big.bin", "application/octet-stream", "blob", hash);
    await syncPeer(A, roomPeerKey(share.slug)); // ships the site_files row; real resolveBlob finds nothing here
    const config = JSON.parse(getPeer(A, roomPeerKey(share.slug))!.config!) as RoomPeerConfig;
    const bytes = new Uint8Array(2_500_000).fill(7); // 3 chunks at 1MiB
    const sent = await pushRoomBlobs(A, config, [hash], async () => bytes);
    expect(sent).toBe(1);
    const blobRes = await fetch(`${room.url}big.bin`, { headers: { cookie } });
    expect(blobRes.status).toBe(200);
    expect((await blobRes.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    // The room stops asking for it.
    const quiet = await roomTransport(config)({
      protocol: ROOM_PROTOCOL_VERSION,
      node_id: "nodeA",
      since: 0,
      changes: [],
      evict: [],
    });
    expect(quiet.need_blobs).toEqual([]);

    // ---- protocol guard: major mismatch answers 409 upgrade_required ---------
    const mismatch = await fetch(`${room.url}owner/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocol: 999, node_id: "nodeA", since: 0, changes: [], evict: [] }),
    });
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { code?: string }).code).toBe("conflict");

    // ---- revoke: destroys the room + removes the peer (decision 3) -----------
    ws.close();
    expect(await revokeShareAction(A, share.slug)).toBe(true);
    expect(getPeer(A, roomPeerKey(share.slug))).toBeNull();
    expect((await fetch(room.url, { headers: { accept: "text/html" } })).status).toBe(404);
  } finally {
    host.stop();
  }
});

test("room e2e: expired room answers expired → owner tears the peer down", async () => {
  const host = startRoomHost();
  try {
    const A = makeHub("nodeB");
    setEdgeConfig(A, { endpoint: host.url, token: OWNER_TOKEN });
    const X = createDatabase(A, { name: "notes" }).id;
    addProperty(A, X, { name: "t", type: "text" });
    createSite(A, { name: "exp" });
    const created = await createShareAction(A, {
      kind: "site",
      ref: "exp",
      transport: "server",
      hosting: "room",
      grants: serializeGrantSet({ v: 1, tables: [{ db: X, ops: ["read"] }] }),
      expiresMs: 60_000,
    });
    const share = getShare(A, created.slug)!;
    expect(getPeer(A, roomPeerKey(share.slug))).not.toBeNull();

    // Flip the room's clock past expiry (the DO's alarm would deleteAll; the
    // protocol-level answer alone must already tear the owner side down).
    const roomDb = host.dbFor(share.slug);
    const cfgRow = roomDb.query("SELECT value FROM room_config WHERE key='config'").get() as {
      value: string;
    };
    const cfg = JSON.parse(cfgRow.value) as { expiresAt: number | null };
    cfg.expiresAt = Date.now() - 1;
    roomDb
      .query("UPDATE room_config SET value = ? WHERE key='config'")
      .run(JSON.stringify(cfg));

    createRecord(A, X, { t: "x" });
    const out = await syncPeer(A, roomPeerKey(share.slug));
    expect(out.ok).toBe(true);
    expect(getPeer(A, roomPeerKey(share.slug))).toBeNull(); // peer torn down
    // Guest face of an expired room: uniform 404 — including the /ws liveness
    // probe, so a subscribed SDK client detects "gone" and stops reconnecting.
    expect((await fetch(`${host.url}/r/${share.slug}/`, { headers: { accept: "text/html" } })).status).toBe(404);
    expect((await fetch(`${host.url}/r/${share.slug}/ws`)).status).toBe(404);
  } finally {
    host.stop();
  }
});

test("room provisioning failure rolls back the share and peer", async () => {
  const host = startRoomHost();
  try {
    const A = makeHub("nodeC");
    setEdgeConfig(A, { endpoint: host.url, token: "wrong-owner-token" });
    createSite(A, { name: "rollback" });
    await expect(
      createShareAction(A, {
        kind: "site",
        ref: "rollback",
        transport: "server",
        hosting: "room",
      }),
    ).rejects.toThrow("refused");
    expect(listShares(A)).toHaveLength(0);
    expect(listPeers(A).filter((p) => p.kind === "room")).toHaveLength(0);
  } finally {
    host.stop();
  }
});
