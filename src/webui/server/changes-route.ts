import { z } from "zod";
import type { Route, RouteCtx } from "../../core/sync/routes.ts";
import { changesAfterSeq } from "../../core/crdt.ts";
import type { DbDriver } from "../../core/driver.ts";

// Live change feed for the browser UI: `GET /api/changes` holds an SSE stream
// and pokes every subscriber when the oplog advances. The CLI and this server
// are separate processes sharing one SQLite file (WAL), so there is no
// in-process hook to observe CLI writes — instead one shared poller per DB
// checks the oplog high-water mark once a second (a MAX() on the rowid-aliased
// PK: microseconds) and diffs with changesAfterSeq only when it moved.
//
// Events carry {datasets, rowIds} — the same shape as the replica worker's
// "synced" event — so the frontend (live.ts) can fan them out through the
// existing SYNCED_EVENT contract and every current subscriber (table, editor,
// relation-titles) refreshes with zero changes.

const POLL_MS = 1000;
// Must undercut Bun.serve's default idleTimeout (10s): a quieter cadence gets
// the socket reaped as idle mid-stream (ERR_INCOMPLETE_CHUNKED_ENCODING) and
// the client burns a reconnect every 10s.
const HEARTBEAT_MS = 8_000;
const BATCH_LIMIT = 1000;
const ROW_IDS_CAP = 500;

interface ChangesPayload {
  datasets: string[];
  rowIds: string[];
  cursor: number;
  /** True when rowIds was capped — datasets stays complete either way. */
  truncated: boolean;
}

/** Aggregate everything after `since` into one poke. Payload size is bounded
 *  regardless of backlog: change bodies are discarded, only dataset names and
 *  (capped) row ids survive, so looping to exhaustion is safe. */
function collectSince(db: DbDriver, since: number): ChangesPayload {
  const datasets = new Set<string>();
  const rowIds = new Set<string>();
  let truncated = false;
  let cursor = since;
  for (;;) {
    const batch = changesAfterSeq(db, cursor, { limit: BATCH_LIMIT });
    for (const c of batch.changes) {
      datasets.add(c.dataset);
      if (rowIds.size < ROW_IDS_CAP) rowIds.add(c.row_id);
      else truncated = true;
    }
    cursor = batch.cursor;
    if (batch.changes.length < BATCH_LIMIT) break;
  }
  return { datasets: [...datasets], rowIds: [...rowIds], cursor, truncated };
}

function highWater(db: DbDriver): number {
  const top = db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number | null };
  return top.m ?? 0;
}

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

type Send = (text: string) => void;

interface Poller {
  subs: Set<Send>;
  cursor: number;
  timer: ReturnType<typeof setInterval>;
  hb: ReturnType<typeof setInterval>;
}

// One poller per DB handle (RouteCtx.db is stable for a server's lifetime;
// WeakMap keeps parallel test servers isolated and lets a closed server's
// poller be collected once its last subscriber detached).
const pollers = new WeakMap<object, Poller>();

function tick(db: DbDriver, poller: Poller): void {
  if (highWater(db) <= poller.cursor) return;
  const payload = collectSince(db, poller.cursor);
  poller.cursor = payload.cursor;
  if (!payload.datasets.length) return; // receipt-only tail: cursor advanced, nothing to say
  const text = sse("changes", payload);
  for (const send of [...poller.subs]) send(text);
}

function attach(db: DbDriver, send: Send): void {
  let poller = pollers.get(db);
  if (!poller) {
    poller = {
      subs: new Set(),
      cursor: highWater(db),
      timer: setInterval(() => tick(db, poller!), POLL_MS),
      hb: setInterval(() => {
        for (const s of [...poller!.subs]) s(": hb\n\n");
      }, HEARTBEAT_MS),
    };
    pollers.set(db, poller);
  }
  poller.subs.add(send);
}

function detach(db: DbDriver, send: Send): void {
  const poller = pollers.get(db);
  if (!poller || !poller.subs.delete(send)) return;
  if (poller.subs.size === 0) {
    clearInterval(poller.timer);
    clearInterval(poller.hb);
    pollers.delete(db);
  }
}

/** Test hook: live subscriber count for a DB (0 = poller torn down). */
export function activeSubscribers(db: object): number {
  return pollers.get(db)?.subs.size ?? 0;
}

/** Test hook: run one poll tick now instead of waiting out POLL_MS. */
export function pokeNow(db: object): void {
  const poller = pollers.get(db);
  if (poller) tick(db as DbDriver, poller);
}

export const changesRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/changes",
    summary:
      "Server-sent event stream of oplog change pokes ({datasets, rowIds, cursor}). " +
      "Reconnect with ?since=<cursor> to catch up on changes missed while disconnected.",
    response: z
      .any()
      .describe(
        "text/event-stream — `hello` {cursor} on connect, then `changes` {datasets, rowIds, cursor, truncated}",
      ),
    handler(req: Request, { db }: RouteCtx): Response {
      const sinceRaw = new URL(req.url).searchParams.get("since");
      const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
      const enc = new TextEncoder();

      let send: Send = () => {};
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        detach(db, send);
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          send = (text) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(text));
            } catch {
              close(); // client went away mid-write
            }
          };
          attach(db, send);
          send(sse("hello", { cursor: since ?? highWater(db) }));
          // Reconnect catch-up: everything the client missed, as one poke.
          // Overlap with the next broadcast is possible and harmless — pokes
          // are idempotent reload triggers, not deltas.
          if (since != null && since < highWater(db)) {
            const payload = collectSince(db, since);
            if (payload.datasets.length) send(sse("changes", payload));
          }
        },
        cancel: () => close(),
      });
      req.signal.addEventListener("abort", close);

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          // Reverse proxies (Caddy, Tailscale Serve) must not buffer the stream.
          "x-accel-buffering": "no",
        },
      });
    },
  },
];
