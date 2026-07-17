// Grant↔inbox auto-wiring: create grant + configured edge → mh-drop.json is
// published with the right contents and the drop is registered at the host;
// grants cleared → file removed + registration deleted. Runs against the real
// edge worker handler in memory (same rig as drop-pull.test.ts).

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDatabase } from "../databases.ts";
import { addProperty } from "../properties.ts";
import {
  createSite,
  setSitePublicGrants,
  getFileRow,
  resolveSite,
  type SiteRow,
} from "../sites-core.ts";
import { createInboxFetch } from "../../workers/edge-worker.ts";
import { memSql } from "../../workers/edge-worker.test-util.ts";
import { httpDropHost, type DropHostApi } from "./drop-host.ts";
import { setEdgeConfig, setDropKnobs } from "./edge-config.ts";
import { getLocalDropKeyring, activeDropKey } from "./drop-keys.ts";
import { syncDropWiring, siteHasCreateGrant, DROP_CONFIG_PATH, MANIFEST_PATH } from "./drop-wire.ts";
import { publishDirectory } from "../sites.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DropConfig } from "../../sdk/drop.ts";

const OWNER = "drt_wiretest";
const ENDPOINT = "http://edge.test";

interface Rig {
  db: Database;
  site: SiteRow;
  dbId: string;
  titleProp: string;
  host: DropHostApi;
  handler: (req: Request) => Promise<Response>;
}

function rig(opts: { edge?: boolean } = {}): Rig {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', 'hostnode')").run();
  const table = createDatabase(db, { name: "guestbook" });
  const title = addProperty(db, table.id, { name: "Title", type: "text" });
  const site = createSite(db, { name: "demo", visibility: "public" });
  const granted = setSitePublicGrants(db, site.id, { v: 1, tables: [{ db: table.id, ops: ["create"] }] });
  if (opts.edge !== false) setEdgeConfig(db, { endpoint: ENDPOINT, token: OWNER });
  const handler = createInboxFetch({ sql: memSql(), ownerToken: OWNER });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
  return { db, site: granted, dbId: table.id, titleProp: title.id, host: httpDropHost(ENDPOINT, OWNER, fetcher), handler };
}

function readDropConfig(db: Database, siteId: string): DropConfig | null {
  const row = getFileRow(db, siteId, DROP_CONFIG_PATH);
  return row ? (JSON.parse(row.content ?? "") as DropConfig) : null;
}

test("wire: create grant + edge → mh-drop.json written with key/endpoint/schema + host registered", async () => {
  const r = rig();
  const w = await syncDropWiring(r.db, r.site, { host: r.host });
  expect(w).toMatchObject({ wired: true, file: "written", registered: true, transport: "edge" });

  const cfg = readDropConfig(r.db, r.site.id)!;
  expect(cfg.v).toBe(1);
  expect(cfg.endpoint).toBe(ENDPOINT);
  expect(cfg.drop_id).toBe(r.site.id);
  const key = activeDropKey(getLocalDropKeyring(r.db)!);
  expect(cfg.key_id).toBe(key.key_id);
  expect(cfg.pk).toBe(key.pk);
  // offline schema: the create-granted table with only guest-writable properties
  expect(cfg.databases).toHaveLength(1);
  expect(cfg.databases![0]!.id).toBe(r.dbId);
  expect(cfg.databases![0]!.properties).toEqual([{ id: r.titleProp, name: "Title", type: "text" }]);
  // registered: the drop answers stats
  expect((await r.host.stats(r.site.id)).envelopes).toBe(0);

  // idempotent re-wire: no new oplog rows for the file
  const w2 = await syncDropWiring(r.db, resolveSite(r.db, r.site.id), { host: r.host });
  expect(w2.file).toBe("unchanged");
});

test("wire: knobs — sitekey + password salt published, secrets only reach the registration", async () => {
  const r = rig();
  setDropKnobs(r.db, r.site.id, {
    turnstileSitekey: "sitekey-public",
    turnstileSecret: "secret-private",
    passwordSalt: "c2FsdA==",
    passwordVerifier: "dmVyaWZpZXI=",
  });
  await syncDropWiring(r.db, r.site, { host: r.host });
  const cfg = readDropConfig(r.db, r.site.id)!;
  expect(cfg.turnstile_sitekey).toBe("sitekey-public");
  expect(cfg.password_salt).toBe("c2FsdA==");
  const raw = JSON.stringify(cfg);
  expect(raw).not.toContain("secret-private");
  expect(raw).not.toContain("dmVyaWZpZXI="); // verifier never published
  // the registration DID carry them: a submission without the verifier is refused
  const res = await r.handler(
    new Request(`${ENDPOINT}/v1/inbox/${r.site.id}/envelopes`, {
      method: "POST",
      headers: { "x-turnstile-token": "t" }, // turnstile check reached only with a token; still fails on pass
      body: JSON.stringify({ v: 1, envelope_id: "e".padEnd(17, "a"), drop_id: r.site.id, enc: "sealed-p256", key_id: "k", sealed: "AA", created_at: 1 }),
    }),
  );
  expect(res.status).toBe(401);
});

test("unwire: clearing the create grant removes mh-drop.json and the registration", async () => {
  const r = rig();
  await syncDropWiring(r.db, r.site, { host: r.host });
  expect(readDropConfig(r.db, r.site.id)).not.toBeNull();

  const cleared = setSitePublicGrants(r.db, r.site.id, null);
  expect(siteHasCreateGrant(cleared)).toBe(false);
  const w = await syncDropWiring(r.db, cleared, { host: r.host });
  expect(w).toMatchObject({ wired: false, file: "removed", transport: null });
  expect(readDropConfig(r.db, r.site.id)).toBeNull();
  // registration gone: public POST now 404s
  const res = await r.handler(
    new Request(`${ENDPOINT}/v1/inbox/${r.site.id}/envelopes`, {
      method: "POST",
      body: JSON.stringify({ v: 1, envelope_id: "e".padEnd(17, "b"), drop_id: r.site.id, enc: "sealed-p256", key_id: "k", sealed: "AA", created_at: 1 }),
    }),
  );
  expect(res.status).toBe(404);
  // a second unwire is a quiet no-op
  const w2 = await syncDropWiring(r.db, resolveSite(r.db, r.site.id), { host: r.host });
  expect(w2.file).toBe("none");
});

test("no edge configured: create grant reports the server transport, no file appears", async () => {
  const r = rig({ edge: false });
  const w = await syncDropWiring(r.db, r.site, { host: r.host });
  expect(w).toMatchObject({ wired: false, file: "none", transport: "server" });
  expect(readDropConfig(r.db, r.site.id)).toBeNull();
});

function readManifest(db: Database, siteId: string): Record<string, unknown> | null {
  const row = getFileRow(db, siteId, MANIFEST_PATH);
  return row ? (JSON.parse(row.content ?? "") as Record<string, unknown>) : null;
}

test("wire: mh-manifest.json is published alongside mh-drop.json (mode live + inbox fallback + drop block)", async () => {
  const r = rig();
  await syncDropWiring(r.db, r.site, { host: r.host });
  const m = readManifest(r.db, r.site.id)!;
  expect(m.v).toBe(1);
  expect(m.mode).toBe("live");
  expect(m.runtimeEndpoint).toBe(""); // relative — same origin as the page
  expect(m.inboxEndpoint).toBe(ENDPOINT);
  expect(m.fallback).toBe("inbox");
  expect(typeof m.policyRevision).toBe("number");
  expect(m.policyRevision).not.toBe(0); // a real content fingerprint
  const drop = m.drop as { drop_id: string; payload_versions: number[]; databases: unknown[] };
  expect(drop.drop_id).toBe(r.site.id);
  expect(drop.payload_versions).toEqual([1]);
  expect(drop.databases).toHaveLength(1);
  // E2EE key material stays inline (not stripped) so the page can seal offline.
  expect((m.drop as { pk?: string }).pk).toBeTruthy();
});

test("revision: editing the grant republishes the manifest with a new policyRevision", async () => {
  const r = rig();
  await syncDropWiring(r.db, r.site, { host: r.host });
  const rev1 = readManifest(r.db, r.site.id)!.policyRevision as number;

  // Widen the grant (create → create+update) and re-wire.
  const widened = setSitePublicGrants(r.db, r.site.id, {
    v: 1,
    tables: [{ db: r.dbId, ops: ["create", "update"] }],
  });
  await syncDropWiring(r.db, widened, { host: r.host });
  const rev2 = readManifest(r.db, r.site.id)!.policyRevision as number;
  expect(rev2).not.toBe(rev1); // the policy moved → the SDK/publisher can see it
});

test("unwire: clearing the create grant removes mh-manifest.json too", async () => {
  const r = rig();
  await syncDropWiring(r.db, r.site, { host: r.host });
  expect(readManifest(r.db, r.site.id)).not.toBeNull();
  const cleared = setSitePublicGrants(r.db, r.site.id, null);
  await syncDropWiring(r.db, cleared, { host: r.host });
  expect(readManifest(r.db, r.site.id)).toBeNull();
});

test("prune: a mirror --prune publish must NOT delete the reserved wiring files", async () => {
  const r = rig();
  await syncDropWiring(r.db, r.site, { host: r.host });
  expect(readDropConfig(r.db, r.site.id)).not.toBeNull();
  expect(readManifest(r.db, r.site.id)).not.toBeNull();

  // Publish a directory that does NOT contain the reserved files, with prune on.
  const dir = mkdtempSync(join(tmpdir(), "mh-prune-"));
  try {
    writeFileSync(join(dir, "index.html"), "<h1>site</h1>");
    const res = await publishDirectory(r.db, r.site.id, dir, { prune: true });
    expect(res.pruned).not.toContain(DROP_CONFIG_PATH);
    expect(res.pruned).not.toContain(MANIFEST_PATH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Both reserved files survived the prune.
  expect(readDropConfig(r.db, r.site.id)).not.toBeNull();
  expect(readManifest(r.db, r.site.id)).not.toBeNull();
});

test("unreachable host: file still published, registration failure reported not thrown", async () => {
  const r = rig();
  const dead = httpDropHost(ENDPOINT, OWNER, (async () => {
    throw new TypeError("connect ECONNREFUSED");
  }) as unknown as typeof fetch);
  const w = await syncDropWiring(r.db, r.site, { host: dead });
  expect(w.wired).toBe(true);
  expect(w.file).toBe("written");
  expect(w.registered).toBe(false);
  expect(w.registerError).toContain("unreachable");
});
