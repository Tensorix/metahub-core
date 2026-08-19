import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../../core/db.ts";
import { createDatabase } from "../../core/databases.ts";
import { addProperty } from "../../core/properties.ts";
import { createRecord } from "../../core/records.ts";
import type { RouteCtx } from "../../core/sync/routes.ts";
import { activeSubscribers, changesRoutes, pokeNow } from "./changes-route.ts";

function db(): Database {
  const d = new Database(":memory:");
  runSchema(d);
  d.query("INSERT INTO meta (key,value) VALUES ('node_id','node-sse')").run();
  return d;
}

const route = changesRoutes.find((r) => r.method === "GET" && r.path === "/api/changes")!;

function open(d: Database, since?: number, signal?: AbortSignal): Response {
  const qs = since != null ? `?since=${since}` : "";
  const req = new Request(`http://local.test/api/changes${qs}`, { signal });
  return route.handler(req, { db: d, node: "node-sse" } as RouteCtx) as Response;
}

/** Incremental SSE parser over a Response body. */
class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private dec = new TextDecoder();
  private buf = "";
  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }
  /** Next non-comment event block (skips heartbeats). */
  async next(): Promise<{ event: string; data: any }> {
    for (;;) {
      const i = this.buf.indexOf("\n\n");
      if (i >= 0) {
        const block = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // pure heartbeat block
        return { event, data: JSON.parse(dataLines.join("\n")) };
      }
      const { done, value } = await this.reader.read();
      if (done) throw new Error("stream ended");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

describe("GET /api/changes", () => {
  test("hello then a poke when the oplog advances", async () => {
    const d = db();
    const sse = new SseReader(open(d));
    const hello = await sse.next();
    expect(hello.event).toBe("hello");
    const c0 = hello.data.cursor as number;

    const database = createDatabase(d, { name: "Tasks" });
    const prop = addProperty(d, database.id, {
      name: "Status",
      type: "select",
      config: { options: ["todo", "done"] },
    });
    const rec = createRecord(d, database.id, { [prop.id]: "todo" });
    pokeNow(d);

    const poke = await sse.next();
    expect(poke.event).toBe("changes");
    expect(poke.data.datasets).toContain("databases");
    expect(poke.data.datasets).toContain("properties");
    expect(poke.data.datasets).toContain("records");
    expect(poke.data.rowIds).toContain(rec.id);
    expect(poke.data.cursor).toBeGreaterThan(c0);
    expect(poke.data.truncated).toBe(false);

    // Idle tick: no new event (nothing to read — assert indirectly by another
    // write arriving as the very next event).
    pokeNow(d);
    createRecord(d, database.id, { [prop.id]: "done" });
    pokeNow(d);
    const poke2 = await sse.next();
    expect(poke2.data.datasets).toEqual(["records"]);
    await sse.cancel();
  });

  test("?since= catches up on changes missed while disconnected", async () => {
    const d = db();
    const first = new SseReader(open(d));
    const c0 = (await first.next()).data.cursor as number;
    await first.cancel();

    const database = createDatabase(d, { name: "Notes" });

    // Reconnect with the stale cursor: catch-up arrives without any tick.
    const sse = new SseReader(open(d, c0));
    const hello = await sse.next();
    expect(hello.event).toBe("hello");
    expect(hello.data.cursor).toBe(c0);
    const poke = await sse.next();
    expect(poke.event).toBe("changes");
    expect(poke.data.datasets).toContain("databases");
    expect(poke.data.rowIds).toContain(database.id);
    expect(poke.data.cursor).toBeGreaterThan(c0);
    await sse.cancel();
  });

  test("subscribers share one poller and detach tears it down", async () => {
    const d = db();
    const a = new SseReader(open(d));
    const b = new SseReader(open(d));
    await a.next();
    await b.next();
    expect(activeSubscribers(d)).toBe(2);

    // Both get the same poke.
    createDatabase(d, { name: "Shared" });
    pokeNow(d);
    expect((await a.next()).data.datasets).toContain("databases");
    expect((await b.next()).data.datasets).toContain("databases");

    await a.cancel(); // stream cancel path
    expect(activeSubscribers(d)).toBe(1);
    await b.cancel();
    expect(activeSubscribers(d)).toBe(0); // poller torn down (intervals cleared)
  });

  test("request abort detaches the subscriber", async () => {
    const d = db();
    const ctrl = new AbortController();
    const sse = new SseReader(open(d, undefined, ctrl.signal));
    await sse.next();
    expect(activeSubscribers(d)).toBe(1);
    ctrl.abort();
    expect(activeSubscribers(d)).toBe(0);
  });
});
