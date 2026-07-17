// MhRoom — the Durable Object shell around the portable room surface
// (core/sync/room-serve.ts over DoSqlDriver). One DO instance = one share's
// room, addressed by env.ROOM.idFromName(slug) from the edge worker's router.
//
// Deliberately a PLAIN class (constructor(state, env)) instead of extending
// `DurableObject` from "cloudflare:workers": the plain-class DO contract
// (fetch/webSocketMessage/webSocketClose/alarm on the instance) predates the
// base class and needs no RPC — and skipping the import keeps this module (and
// edge-worker.ts, which re-exports it) importable under `bun test`. Runtime
// globals that only exist in workerd (WebSocketPair, scheduler, …) are reached
// through feature-detected lookups for the same reason.
//
// WS strategy (design.md §6): Hibernation API — state.acceptWebSocket +
// serializeAttachment (the session survives eviction) + setWebSocketAutoResponse
// ping/pong (zero-wake keepalive). broadcast = {"type":"poke","seq":n}; the
// only alarm is the expires_at self-destruct.

import { DoSqlDriver, type DoStorageLike } from "../room/do-driver.ts";
import {
  createRoomFetch,
  roomWsSession,
  roomWsMessage,
} from "../core/sync/room-serve.ts";
import { readRoomConfig, roomExpired } from "../core/sync/room-protocol.ts";

// Minimal local typings so this file needs no @cloudflare/workers-types.
interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

interface RoomState {
  storage: DoStorageLike & {
    deleteAll(): Promise<void> | void;
    setAlarm(scheduledTime: number): Promise<void> | void;
    deleteAlarm?(): Promise<void> | void;
  };
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
  acceptWebSocket(ws: WsLike): void;
  getWebSockets(): WsLike[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

interface RoomEnv {
  OWNER_TOKEN?: string;
}

const g = globalThis as Record<string, unknown>;

export class MhRoom {
  private readonly db: DoSqlDriver;
  private readonly handler: (req: Request) => Promise<Response>;

  constructor(
    private readonly state: RoomState,
    env: RoomEnv,
  ) {
    this.db = new DoSqlDriver(state.storage);
    this.handler = createRoomFetch({
      db: this.db,
      ownerToken: env.OWNER_TOKEN,
      poke: (seq) => this.broadcast(seq),
      destroy: async () => {
        for (const ws of this.state.getWebSockets()) {
          try {
            ws.close(1001, "room destroyed");
          } catch {
            /* already gone */
          }
        }
        await this.state.storage.deleteAlarm?.();
        await this.state.storage.deleteAll();
      },
      setAlarm: async (at) => {
        if (at == null) await this.state.storage.deleteAlarm?.();
        else await this.state.storage.setAlarm(at);
      },
      // scheduler.wait is real I/O in workerd — the frozen request clock
      // advances across it (spike ⑧), giving the HLC counter headroom.
      yieldClock: async () => {
        const scheduler = g.scheduler as { wait?: (ms: number) => Promise<void> } | undefined;
        if (scheduler?.wait) await scheduler.wait(1);
      },
    });
    // Readiness contract: no request runs before construction settles. The
    // database is either provisioned (room_config exists — created inside
    // POST /owner/provision) or every guest route 404s until it is; there is
    // nothing async to prepare, but the barrier keeps that invariant explicit.
    void state.blockConcurrencyWhile?.(async () => {});
    const Pair = g.WebSocketRequestResponsePair as
      | (new (request: string, response: string) => unknown)
      | undefined;
    if (Pair && state.setWebSocketAutoResponse) {
      state.setWebSocketAutoResponse(new Pair("ping", "pong"));
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Route to upgrade() only for a REAL websocket handshake. A plain GET on
    // /ws falls through to the portable handler, which answers 426 for a live
    // room but 404 for a dead/expired one (room-serve gate) — the SDK's
    // liveness probe depends on that distinction, and answering 426
    // unconditionally here would hide "room gone" behind an alive-looking 426
    // on the only production deployment.
    if (
      /^\/r\/[^/]+\/ws$/.test(url.pathname) &&
      (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
    )
      return this.upgrade(req);
    return this.handler(req);
  }

  private async upgrade(req: Request): Promise<Response> {
    const sess = await roomWsSession(this.db, req);
    // Uniform 404: unprovisioned, expired and locked-without-session all look alike.
    if (!sess) return new Response("not found", { status: 404 });
    const PairCtor = g.WebSocketPair as (new () => Record<string, WsLike>) | undefined;
    if (!PairCtor) return new Response("websockets unavailable", { status: 501 });
    const pair = new PairCtor();
    const client = pair[0]!;
    const server = pair[1]!;
    this.state.acceptWebSocket(server);
    server.serializeAttachment?.({ sub: sess.sub });
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WsLike });
  }

  async webSocketMessage(ws: WsLike, message: unknown): Promise<void> {
    if (typeof message !== "string") return;
    const att = (ws.deserializeAttachment?.() ?? {}) as { sub?: string };
    const out = await roomWsMessage(this.db, att.sub ?? "", message);
    if (out.reply) {
      try {
        ws.send(out.reply);
      } catch {
        /* socket already closed */
      }
    }
    if (out.poke) this.broadcast(out.seq);
  }

  async alarm(): Promise<void> {
    // The only alarm is the expires_at self-destruct.
    let cfg;
    try {
      cfg = readRoomConfig(this.db);
    } catch {
      // Unprovisioned / already wiped — nothing to protect, clear and stop.
      await this.state.storage.deleteAll();
      return;
    }
    if (!roomExpired(cfg)) {
      // Fired early, or exactly on the expiry millisecond (roomExpired uses a
      // strict `>`): a naked return would consume the alarm and leave the room
      // to linger forever if the owner never syncs again. Re-arm at the real
      // deadline instead so the self-destruct still fires.
      const next = cfg.expiresAt != null ? Math.max(Date.now() + 1000, cfg.expiresAt) : Date.now() + 60_000;
      await this.state.storage.setAlarm(next);
      return;
    }
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1001, "room expired");
      } catch {
        /* already gone */
      }
    }
    await this.state.storage.deleteAll();
  }

  private broadcast(seq: number): void {
    const msg = JSON.stringify({ type: "poke", seq });
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* skip dead sockets */
      }
    }
  }
}
