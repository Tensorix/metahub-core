// The edge worker's handler is a pure function over an injected SQL surface,
// so the FULL API surface — registration, submission gates (404/413/401/429),
// duplicate replay, list/ack/stats — is exercised here against in-memory
// SQLite: this doubles as the "fake DropHost" self-test the pull tests build on.

import { test, expect } from "bun:test";
import {
  createInboxFetch,
  EDGE_WORKER_VERSION,
  DROP_ENVELOPE_LIMIT_BYTES,
  type InboxDeps,
} from "./edge-worker.ts";
import { memSql } from "./edge-worker.test-util.ts";

const OWNER = "drt_testownersecret";

function makeHandler(extra: Partial<InboxDeps> = {}): (req: Request) => Promise<Response> {
  return createInboxFetch({ sql: memSql(), ownerToken: OWNER, ...extra });
}

const BASE = "http://edge.test";
const auth = { authorization: `Bearer ${OWNER}` };

function envelope(id: string, dropId = "site_demo-abc123"): string {
  return JSON.stringify({
    v: 1,
    envelope_id: id,
    drop_id: dropId,
    enc: "sealed-p256",
    key_id: "k1",
    sealed: "AAAA",
    created_at: Date.now(),
  });
}

async function register(h: (r: Request) => Promise<Response>, dropId = "site_demo-abc123", body: unknown = {}) {
  const res = await h(
    new Request(`${BASE}/v1/inbox/${dropId}`, { method: "PUT", headers: auth, body: JSON.stringify(body) }),
  );
  expect(res.status).toBe(200);
}

test("health is open and reports the worker version", async () => {
  const h = makeHandler();
  const res = await h(new Request(`${BASE}/health`));
  expect(res.status).toBe(200);
  const d = (await res.json()) as { ok: boolean; version: string };
  expect(d.ok).toBe(true);
  expect(d.version).toBe(EDGE_WORKER_VERSION);
});

test("owner routes without / with a wrong token → 401 auth", async () => {
  const h = makeHandler();
  for (const headers of [{}, { authorization: "Bearer drt_wrong" }]) {
    const res = await h(new Request(`${BASE}/v1/inbox/site_x`, { method: "PUT", headers, body: "{}" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("auth");
  }
  // an empty owner token denies everything (never an open gate)
  const open = makeHandler({ ownerToken: undefined });
  const res = await open(new Request(`${BASE}/v1/inbox/site_x/stats`, { headers: auth }));
  expect(res.status).toBe(401);
});

test("POST to an unregistered drop → 404 (no garbage namespaces)", async () => {
  const h = makeHandler();
  const res = await h(
    new Request(`${BASE}/v1/inbox/site_nope/envelopes`, { method: "POST", body: envelope("e1", "site_nope") }),
  );
  expect(res.status).toBe(404);
});

test("submit → 200 with envelope_id + server_time; duplicate replay → 200 duplicate", async () => {
  const now = 1_700_000_000_000;
  const h = makeHandler({ now: () => now });
  await register(h);
  const res = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e1".padEnd(17, "x")) }),
  );
  expect(res.status).toBe(200);
  const d = (await res.json()) as { envelope_id: string; server_time: number };
  expect(d.server_time).toBe(now);
  const dup = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e1".padEnd(17, "x")) }),
  );
  expect(dup.status).toBe(200);
  expect(((await dup.json()) as { duplicate: boolean }).duplicate).toBe(true);
  // still exactly one stored
  const list = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes?after_id=0`, { headers: auth }));
  expect(((await list.json()) as { rows: unknown[] }).rows).toHaveLength(1);
});

test("oversize envelope → 413; malformed / mismatched drop_id → 400", async () => {
  const h = makeHandler();
  await register(h);
  const big = JSON.stringify({ v: 1, envelope_id: "e1", drop_id: "site_demo-abc123", enc: "sealed-p256", key_id: "k", sealed: "A".repeat(DROP_ENVELOPE_LIMIT_BYTES), created_at: 1 });
  const res413 = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: big }));
  expect(res413.status).toBe(413);
  const res400 = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: "}{" }));
  expect(res400.status).toBe(400);
  const mismatch = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e2", "site_other") }),
  );
  expect(mismatch.status).toBe(400);
});

test("capacity: envelope-count and byte ceilings answer 429 drop_full (atomically)", async () => {
  const h = makeHandler();
  await register(h, "site_demo-abc123", { max_envelopes: 2 });
  for (const id of ["e_aaaaaaaaaaaaaaaa", "e_bbbbbbbbbbbbbbbb"]) {
    const ok = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope(id) }));
    expect(ok.status).toBe(200);
  }
  const full = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e_cccccccccccccccc") }),
  );
  expect(full.status).toBe(429);
  expect(((await full.json()) as { code: string }).code).toBe("drop_full");

  // byte ceiling: a tiny max_bytes refuses even the first envelope
  const h2 = makeHandler();
  await register(h2, "site_demo-abc123", { max_bytes: 10 });
  const res = await h2(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e_dddddddddddddddd") }),
  );
  expect(res.status).toBe(429);
});

test("password verifier gates submissions (constant-time compare)", async () => {
  const h = makeHandler();
  await register(h, "site_demo-abc123", { password_verifier: "sesame-verifier" });
  const no = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e_1aaaaaaaaaaaaaaa") }));
  expect(no.status).toBe(401);
  const wrong = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, {
      method: "POST",
      headers: { "x-drop-pass": "guess" },
      body: envelope("e_2aaaaaaaaaaaaaaa"),
    }),
  );
  expect(wrong.status).toBe(401);
  const right = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, {
      method: "POST",
      headers: { "x-drop-pass": "sesame-verifier" },
      body: envelope("e_3aaaaaaaaaaaaaaa"),
    }),
  );
  expect(right.status).toBe(200);
});

test("turnstile is verified only when a secret is registered", async () => {
  const calls: [string, string][] = [];
  const h = makeHandler({
    verifyTurnstile: async (secret, token) => {
      calls.push([secret, token]);
      return token === "good-token";
    },
  });
  await register(h, "site_demo-abc123", { turnstile_secret: "ts-secret" });
  const no = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e_4aaaaaaaaaaaaaaa") }));
  expect(no.status).toBe(401);
  const bad = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, {
      method: "POST",
      headers: { "x-turnstile-token": "bad" },
      body: envelope("e_5aaaaaaaaaaaaaaa"),
    }),
  );
  expect(bad.status).toBe(401);
  const good = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, {
      method: "POST",
      headers: { "x-turnstile-token": "good-token" },
      body: envelope("e_6aaaaaaaaaaaaaaa"),
    }),
  );
  expect(good.status).toBe(200);
  expect(calls.every(([s]) => s === "ts-secret")).toBe(true);
});

test("list honors after_id/limit; ack deletes; stats reports; unregister tears down", async () => {
  const h = makeHandler();
  await register(h);
  for (let i = 0; i < 5; i++) {
    await h(
      new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope(`e_${i}aaaaaaaaaaaaaaa`) }),
    );
  }
  const page1 = (await (
    await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes?after_id=0&limit=2`, { headers: auth }))
  ).json()) as { rows: { id: number; envelope: { envelope_id: string } }[] };
  expect(page1.rows).toHaveLength(2);
  const page2 = (await (
    await h(
      new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes?after_id=${page1.rows[1]!.id}&limit=10`, { headers: auth }),
    )
  ).json()) as { rows: { id: number }[] };
  expect(page2.rows).toHaveLength(3);

  const ack = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, {
      method: "DELETE",
      headers: auth,
      body: JSON.stringify({ ids: page1.rows.map((r) => r.id) }),
    }),
  );
  expect(((await ack.json()) as { deleted: number }).deleted).toBe(2);

  const stats = (await (
    await h(new Request(`${BASE}/v1/inbox/site_demo-abc123/stats`, { headers: auth }))
  ).json()) as { envelopes: number; max_envelopes: number };
  expect(stats.envelopes).toBe(3);
  expect(stats.max_envelopes).toBe(2000);

  const del = await h(new Request(`${BASE}/v1/inbox/site_demo-abc123`, { method: "DELETE", headers: auth }));
  expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
  const after = await h(
    new Request(`${BASE}/v1/inbox/site_demo-abc123/envelopes`, { method: "POST", body: envelope("e_zaaaaaaaaaaaaaaa") }),
  );
  expect(after.status).toBe(404);
});
