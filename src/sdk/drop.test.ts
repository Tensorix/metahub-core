// SDK write-drop client: mini-HLC ↔ core parseHlc interop, optimistic-echo
// three states (pending → merge passthrough → reconcile), clock-offset learning
// and the client.ts auto-route (401/network → sealed drop when mh-drop.json
// exists). Envelopes land on the REAL edge worker handler.

import { test, expect } from "bun:test";
import { parseHlc } from "../core/hlc.ts";
import { errorCode } from "../core/errors.ts";
import { createInboxFetch } from "../workers/edge-worker.ts";
import { memSql } from "../workers/edge-worker.test-util.ts";
import { generateSealKeypair, openSealed } from "../core/sync/seal.ts";
import { toB64, fromB64 } from "../core/sync/e2ee.ts";
import { decodeDropPayload, parseDropEnvelope } from "../core/sync/drop-protocol.ts";
import { createDrop, type DropConfig, type DropStorage } from "./drop.ts";
import { createClient } from "./client.ts";

const ENDPOINT = "http://edge.test";
const OWNER = "drt_sdktest";
const DROP_ID = "site_demo-sdk001";

function memStorage(): DropStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
}

interface Host {
  handler: (req: Request) => Promise<Response>;
  fetcher: typeof fetch;
}

async function makeHost(now?: () => number): Promise<Host> {
  const handler = createInboxFetch({ sql: memSql(), ownerToken: OWNER, now });
  await handler(
    new Request(`${ENDPOINT}/v1/inbox/${DROP_ID}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}` },
      body: "{}",
    }),
  );
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  return { handler, fetcher };
}

async function makeConfig(): Promise<{ cfg: DropConfig; sk: Uint8Array }> {
  const kp = await generateSealKeypair();
  return {
    sk: kp.privateKey,
    cfg: {
      v: 1,
      endpoint: ENDPOINT,
      drop_id: DROP_ID,
      key_id: "k1",
      pk: toB64(kp.publicKey),
      databases: [
        {
          id: "db_guestbook-x1",
          name: "guestbook",
          properties: [{ id: "prop_title-x1", name: "Title", type: "text" }],
        },
      ],
    },
  };
}

test("mini-HLC interoperates with core parseHlc and is monotonic", async () => {
  const host = await makeHost();
  const { cfg, sk } = await makeConfig();
  const drop = createDrop(cfg, { fetcher: host.fetcher, storage: memStorage() });
  const rec = await drop.createRecord("guestbook", { Title: "hlc check" });

  // read the sealed payload back off the host and inspect its changes
  const list = await host.handler(
    new Request(`${ENDPOINT}/v1/inbox/${DROP_ID}/envelopes?after_id=0`, {
      headers: { authorization: `Bearer ${OWNER}` },
    }),
  );
  const rows = ((await list.json()) as { rows: { envelope: unknown }[] }).rows;
  const env = parseDropEnvelope(rows[0]!.envelope);
  const payload = decodeDropPayload(await openSealed(sk, fromB64(cfg.pk), fromB64(env.sealed)));

  expect(payload.guest_node).toBe(drop.guest);
  expect(payload.guest_node).toMatch(/^g[0-9a-z]{8}$/);
  const hlcs = payload.changes.map((c) => c.hlc);
  const wall = Date.now();
  let prev = "";
  for (const h of hlcs) {
    const parsed = parseHlc(h); // fixed-width core format parses cleanly
    expect(parsed.node).toBe(drop.guest);
    expect(Math.abs(parsed.millis - wall)).toBeLessThan(60_000);
    expect(h > prev).toBe(true); // strictly increasing (lexicographic == causal)
    prev = h;
  }
  // created_hlc value equals the first op's hlc (core createRecord convention)
  const created = payload.changes.find((c) => c.col === "created_hlc")!;
  expect(JSON.parse(created.value!)).toBe(payload.changes[0]!.hlc);
  expect(rec.id).toBe(payload.changes[0]!.row_id);
});

test("clock offset learns from server_time (skewed device stays inside the clamp)", async () => {
  const serverNow = Date.now() + 10 * 60_000; // server 10min ahead of the device
  const host = await makeHost(() => serverNow);
  const { cfg } = await makeConfig();
  const store = memStorage();
  const drop = createDrop(cfg, { fetcher: host.fetcher, storage: store });
  await drop.createRecord("guestbook", { Title: "first (device clock)" });
  // offset persisted; a NEW client on the same storage mints server-aligned HLCs
  const drop2 = createDrop(cfg, { fetcher: host.fetcher, storage: store });
  const rec2 = await drop2.createRecord("guestbook", { Title: "second (corrected)" });
  expect(rec2._pending).toBe(true);
  const storedOffset = Number(store.get("mh_drop_clock:" + ENDPOINT));
  expect(Math.abs(storedOffset - 10 * 60_000)).toBeLessThan(5_000);
});

test("optimistic echo: pending → merge passthrough → reconcile on server appearance", async () => {
  const host = await makeHost();
  const { cfg } = await makeConfig();
  const store = memStorage();
  const drop = createDrop(cfg, { fetcher: host.fetcher, storage: store });

  // state 1: after submit, the record is pending
  const rec = await drop.createRecord("guestbook", { Title: "wait for me" });
  expect(drop.pending("guestbook")).toHaveLength(1);
  expect(drop.pending()[0]!._pending).toBe(true);

  // state 2: server rows without it → merge appends the pending echo
  const serverRows = [{ id: "rec_other", database_id: "db_guestbook-x1", values: {}, cells: {} }];
  const merged = drop.merge(serverRows, "guestbook");
  expect(merged).toHaveLength(2);
  expect((merged[1] as { _pending?: boolean })._pending).toBe(true);
  expect(drop.pending()).toHaveLength(1); // still pending

  // state 3: the row shows up server-side → reconciled away, storage cleaned
  const landed = [...serverRows, { id: rec.id, database_id: "db_guestbook-x1", values: {}, cells: {} }];
  const merged2 = drop.merge(landed, "guestbook");
  expect(merged2).toHaveLength(2);
  expect(merged2.some((r) => (r as { _pending?: boolean })._pending)).toBe(false);
  expect(drop.pending()).toHaveLength(0);
});

test("guest identity persists across clients on the same storage", async () => {
  const host = await makeHost();
  const { cfg } = await makeConfig();
  const store = memStorage();
  const a = createDrop(cfg, { fetcher: host.fetcher, storage: store });
  const b = createDrop(cfg, { fetcher: host.fetcher, storage: store });
  expect(a.guest).toBe(b.guest);
  const c = createDrop(cfg, { fetcher: host.fetcher, storage: memStorage() });
  expect(c.guest).not.toBe(a.guest); // fresh visitor → fresh identity
});

test("unknown table / column fail loudly with codes", async () => {
  const host = await makeHost();
  const { cfg } = await makeConfig();
  const drop = createDrop(cfg, { fetcher: host.fetcher, storage: memStorage() });
  let code: string | undefined;
  await drop.createRecord("nope", {}).catch((e) => (code = errorCode(e)));
  expect(code).toBe("not_found");
  await drop.createRecord("guestbook", { Bogus: 1 }).catch((e) => (code = errorCode(e)));
  expect(code).toBe("not_found");
});

test("client.ts auto-route: 401 on the realtime endpoint falls back to the sealed drop", async () => {
  const host = await makeHost();
  const { cfg } = await makeConfig();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/records")) {
        return Response.json({ error: "unauthorized", code: "auth" }, { status: 401 });
      }
      if (url.endsWith("/sites/demo/mh-drop.json")) {
        return Response.json(cfg);
      }
      if (url.includes("/v1/inbox/")) {
        return host.handler(new Request(url, init));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const api = createClient({ baseUrl: "http://origin.test/sites/demo" });
    const rec = (await api.createRecord("guestbook", { Title: "routed" })) as unknown as {
      id: string;
      _pending?: boolean;
    };
    expect(rec._pending).toBe(true);
    expect(rec.id).toMatch(/^rec_/);
    // the envelope really landed at the host
    const list = await host.handler(
      new Request(`${ENDPOINT}/v1/inbox/${DROP_ID}/envelopes?after_id=0`, {
        headers: { authorization: `Bearer ${OWNER}` },
      }),
    );
    expect(((await list.json()) as { rows: unknown[] }).rows).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("client.ts auto-route: a 400 answer does NOT fall back (real refusals stay loud)", async () => {
  const realFetch = globalThis.fetch;
  let dropConfigFetched = false;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/records"))
        return Response.json({ error: "bad value", code: "invalid_input" }, { status: 400 });
      if (url.endsWith("mh-drop.json")) dropConfigFetched = true;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const api = createClient({ baseUrl: "http://origin.test/sites/demo" });
    let status: number | undefined;
    await api.createRecord("guestbook", { Title: "x" }).catch((e) => (status = e.status));
    expect(status).toBe(400);
    expect(dropConfigFetched).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
