import { test, expect, afterEach } from "bun:test";
import { detectBase, createClient } from "./client.ts";
import { deriveDropPasswordVerifier } from "./drop.ts";
import { generateSealKeypair } from "../core/sync/seal.ts";
import { toB64 } from "../core/sync/e2ee.ts";

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

test("channel selection: with a manifest declaring no inbox fallback, a 401 write throws instead of silently dropping", async () => {
  const realFetch2 = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const u = String(input);
    calls.push(u);
    if (u.includes("mh-manifest.json"))
      return Promise.resolve(
        new Response(JSON.stringify({ v: 1, mode: "live", policyRevision: 0 }), { status: 200 }),
      );
    if (u.includes("/api/records"))
      return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized", code: "auth" }), { status: 401 }));
    // A drop config exists but must NOT be consulted (fallback not declared).
    if (u.includes("mh-drop.json")) return Promise.resolve(new Response("{}", { status: 200 }));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  try {
    const api = createClient({ baseUrl: "http://x/sites/demo" });
    let threw = false;
    try {
      await api.createRecord("db1", { Msg: "hi" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // explicit: no silent drop
    expect(calls.some((c) => c.includes("mh-manifest.json"))).toBe(true); // manifest consulted
  } finally {
    globalThis.fetch = realFetch2;
  }
});

test("absolute root baseUrl stays on the owner API and sends a plain body", async () => {
  let body: unknown;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ id: "rec_1", database_id: "db1", values: {}, cells: {} });
  }) as typeof fetch;
  await createClient({ baseUrl: "https://hub.example" }).createRecord("db1", { Title: "x" });
  expect(body).toEqual({ Title: "x" });
});

test("absolute root runtimeEndpoint stays plain even when selected by a manifest", async () => {
  let body: unknown;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://static.example/deployment.json")
      return Response.json({
        v: 1,
        mode: "live",
        runtimeEndpoint: "https://hub.example",
        policyRevision: 1,
      });
    body = JSON.parse(String(init?.body));
    return Response.json({ id: "rec_1", database_id: "db1", values: {}, cells: {} });
  }) as typeof fetch;
  await createClient({
    baseUrl: "https://static.example",
    manifestUrl: "https://static.example/deployment.json",
  }).createRecord("db1", { Title: "x" });
  expect(body).toEqual({ Title: "x" });
});

test("live manifest routes data calls through runtimeEndpoint", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/sites/demo/mh-manifest.json"))
      return Response.json({
        v: 1,
        mode: "live",
        runtimeEndpoint: "https://runtime.example/surface",
        policyRevision: 1,
      });
    if (url === "https://runtime.example/surface/api/records?db=db1")
      return Response.json([]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  await createClient({ baseUrl: "https://static.example/sites/demo" }).listRecords("db1");
  expect(calls).toContain("https://runtime.example/surface/api/records?db=db1");
  expect(calls.some((url) => url.includes("static.example/sites/demo/api"))).toBe(false);
});

test("static-async create goes directly to the embedded inbox and stays visibly pending", async () => {
  const kp = await generateSealKeypair();
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === "/mh-manifest.json")
      return Response.json({
        v: 1,
        mode: "static-async",
        inboxEndpoint: "https://edge.example",
        policyRevision: 1,
        drop: {
          drop_id: "site_demo",
          key_id: "key1",
          pk: toB64(kp.publicKey),
          payload_versions: [1],
          databases: [
            {
              id: "db1",
              name: "guestbook",
              properties: [{ id: "prop1", name: "Title", type: "text" }],
            },
          ],
        },
      });
    if (url === "https://edge.example/v1/inbox/site_demo/envelopes")
      return Response.json({ ok: true, server_time: Date.now() });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const rec = await createClient().createRecord("guestbook", { Title: "queued" });
  expect("_pending" in rec && rec._pending).toBe(true);
  expect(calls.some((url) => url.includes("/api/records"))).toBe(false);
  expect(calls).toContain("https://edge.example/v1/inbox/site_demo/envelopes");
});

test("static-async update/delete fail explicitly without probing a live API", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return Response.json({
      v: 1,
      mode: "static-async",
      inboxEndpoint: "https://edge.example",
      policyRevision: 1,
      drop: { drop_id: "d", key_id: "k", pk: "AA" },
    });
  }) as typeof fetch;
  const client = createClient();
  await expect(client.updateRecord("r", { Title: "x" })).rejects.toThrow(/does not support/);
  await expect(client.deleteRecord("r")).rejects.toThrow(/does not support/);
  expect(calls.filter((url) => url.includes("/api/"))).toHaveLength(0);
});

test("a 200 malformed manifest fails closed instead of enabling legacy routing", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("mh-manifest.json")) return Response.json({ mode: "live" });
    return Response.json([]);
  }) as typeof fetch;
  await expect(
    createClient({ baseUrl: "https://x/sites/demo" }).listRecords("db1"),
  ).rejects.toThrow(/malformed/);
  expect(calls.some((url) => url.includes("/api/records"))).toBe(false);
});

test("legacy guest server 404s the wrapper once, then receives the plain body", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("mh-manifest.json")) return new Response("missing", { status: 404 });
    if (url.includes("/api/records")) {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if ("$intent" in body)
        return Response.json({ error: "unknown property", code: "not_found" }, { status: 404 });
      return Response.json({ id: "rec_1", database_id: "db1", values: {}, cells: {} });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  await createClient({ baseUrl: "https://x/sites/demo" }).createRecord("db1", { Title: "x" });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toHaveProperty("$intent");
  expect(bodies[1]).toEqual({ Title: "x" });
});

test("live gated writes attach password and Turnstile proofs", async () => {
  const salt = "c2FsdC1ieXRlcw==";
  let seenHeaders: Headers | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("mh-manifest.json"))
      return Response.json({
        v: 1,
        mode: "live",
        runtimeEndpoint: "",
        policyRevision: 1,
        drop: { drop_id: "d", key_id: "k", pk: "AA", password_salt: salt },
      });
    seenHeaders = new Headers(init?.headers);
    return Response.json({ id: "rec_1", database_id: "db1", values: {}, cells: {} });
  }) as typeof fetch;
  await createClient({
    baseUrl: "https://x/sites/demo",
    dropPassword: "secret",
  }).createRecord("db1", { Title: "x" }, { turnstileToken: "turn-token" });
  expect(seenHeaders!.get("x-turnstile-token")).toBe("turn-token");
  expect(seenHeaders!.get("x-drop-pass")).toBe(
    await deriveDropPasswordVerifier("secret", salt),
  );
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
