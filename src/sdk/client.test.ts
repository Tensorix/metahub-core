import { test, expect, afterEach } from "bun:test";
import { detectBase, createClient } from "./client.ts";

// ---- room WS reconnect harness ------------------------------------------------
// Fake WebSocket + captured timers: the reconnect loop schedules real setTimeout
// backoffs (1s → 30s), so tests drive time by invoking the recorded callbacks.

type Handler = ((ev: never) => void) | null;
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  close(): void {}
}

const realWS = globalThis.WebSocket;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
let pendingTimers: (() => void)[] = [];

function stubWsWorld(probeStatus: number | "network-error") {
  FakeWS.instances = [];
  pendingTimers = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWS;
  globalThis.fetch = ((input: string | URL | Request) => {
    probes.push(String(input));
    if (probeStatus === "network-error") return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response("x", { status: probeStatus }));
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: () => void) => {
    pendingTimers.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}
let probes: string[] = [];

afterEach(() => {
  (globalThis as Record<string, unknown>).WebSocket = realWS;
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  probes = [];
});

/** Drive the current dial to a close-without-open, then run the retry timer. */
function failDial(code = 1006) {
  const ws = FakeWS.instances.at(-1)!;
  ws.onclose?.({ code });
}
const runTimers = () => {
  const t = pendingTimers.splice(0);
  for (const fn of t) fn();
};

test("room WS: close 1008 (proxy policy) is NOT terminal — it backs off and redials", () => {
  stubWsWorld(426);
  const events: { seq?: number; gone?: true }[] = [];
  const off = createClient({ baseUrl: "http://x/r/slug1234" }).onUpdate((i) => events.push(i));
  expect(FakeWS.instances).toHaveLength(1);
  failDial(1008); // the old AUTH_CLOSE would silently stop forever here
  runTimers();
  expect(FakeWS.instances).toHaveLength(2); // redialed
  expect(events).toEqual([]); // and did NOT report the room gone
  off();
});

test("room WS: 3 never-opened dials + probe 404 → terminal stop with cb({gone:true})", async () => {
  stubWsWorld(404);
  const events: { seq?: number; gone?: true }[] = [];
  createClient({ baseUrl: "http://x/r/slug1234" }).onUpdate((i) => events.push(i));
  failDial(); // attempt 1 — backoff
  runTimers();
  failDial(); // attempt 2 — backoff
  runTimers();
  failDial(); // attempt 3 — probes the http(s) /ws URL
  await Promise.resolve(); // let the probe promise settle
  await Promise.resolve();
  expect(probes.length).toBe(1);
  expect(probes[0]).toBe("http://x/r/slug1234/ws"); // http form, not ws://
  expect(events).toEqual([{ gone: true }]); // terminal, surfaced once
  runTimers();
  expect(FakeWS.instances).toHaveLength(3); // no further redial
});

test("room WS: probe 426 (room alive, e.g. transient upstream failure) keeps backing off", async () => {
  stubWsWorld(426);
  createClient({ baseUrl: "http://x/r/slug1234" }).onUpdate(() => {});
  failDial();
  runTimers();
  failDial();
  runTimers();
  failDial(); // triggers the probe → 426 → retry
  await Promise.resolve();
  await Promise.resolve();
  expect(probes.length).toBe(1);
  runTimers();
  expect(FakeWS.instances).toHaveLength(4); // still redialing
});

test("detectBase maps the three mounts", () => {
  // site mount → its prefix (owner full api / public granted api)
  expect(detectBase("/sites/demo/")).toBe("/sites/demo");
  expect(detectBase("/sites/demo/index.html")).toBe("/sites/demo");
  expect(detectBase("/sites/my-app/deep/route")).toBe("/sites/my-app");
  // share mount → its prefix (grant-scoped, session-gated)
  expect(detectBase("/share/abc123xyz/")).toBe("/share/abc123xyz");
  expect(detectBase("/share/abc123xyz/page.html")).toBe("/share/abc123xyz");
  // room mount → its prefix (grant-scoped + live WS pokes)
  expect(detectBase("/r/abc123xyz/")).toBe("/r/abc123xyz");
  expect(detectBase("/r/abc123xyz/index.html")).toBe("/r/abc123xyz");
  // everything else → the root api
  expect(detectBase("/")).toBe("");
  expect(detectBase("/app")).toBe("");
  expect(detectBase("/docs")).toBe("");
  expect(detectBase("/sites")).toBe(""); // bare /sites is not a mount
  expect(detectBase("/sitesX/nope")).toBe("");
  // no DOM (this test runs without location) → root
  expect(detectBase()).toBe("");
});

test("createClient exposes the full typed method surface", () => {
  const api = createClient({ baseUrl: "http://127.0.0.1:1" });
  for (const m of [
    "listDatabases",
    "listProperties",
    "listRecords",
    "getRecord",
    "createRecord",
    "updateRecord",
    "listDocuments",
    "getDocument",
    "search",
    "onUpdate",
  ]) {
    expect(typeof (api as Record<string, unknown>)[m]).toBe("function");
  }
});
