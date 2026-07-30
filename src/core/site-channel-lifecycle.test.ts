import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema-init.ts";
import { createSite } from "./sites-core.ts";
import {
  getSiteChannelObservation,
  putSiteChannel,
  sitePublicAccessState,
} from "./site-channel-store.ts";
import { requestChannelRevocation } from "./site-channel-lifecycle.ts";

function node(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key,value) VALUES ('node_id',?)").run(id);
  return db;
}

const mkChannel = (
  db: Database,
  siteId: string,
  over: Partial<Parameters<typeof putSiteChannel>[1]> = {},
) =>
  putSiteChannel(db, {
    siteId,
    audience: "link",
    hosting: "device",
    targetRef: "node-a",
    canonicalUrl: "http://a/share/x",
    ...over,
  });

test("serving device: revoked observation lands immediately, no reconcile needed", () => {
  const d = node("node-a");
  const site = createSite(d, { name: "s1" });
  const c = mkChannel(d, site.id, { targetRef: "node-a" });
  const r = requestChannelRevocation(d, c.id);
  expect(r.needsReconcile).toBe(false);
  expect(getSiteChannelObservation(d, c.id)?.status).toBe("revoked");
});

test("controller (not serving): caller must run the reconciler", () => {
  const d = node("node-a");
  const site = createSite(d, { name: "s2" });
  const c = mkChannel(d, site.id, { hosting: "edge", targetRef: "slug1" });
  const r = requestChannelRevocation(d, c.id);
  expect(r.needsReconcile).toBe(true);
  // No fabricated observation — teardown evidence comes from the reconciler.
  expect(getSiteChannelObservation(d, c.id)).toBeNull();
});

test("neither serving nor controlling: honest cleanup_pending (等待控制设备)", () => {
  const d = node("node-c");
  const site = createSite(d, { name: "s3" });
  const c = mkChannel(d, site.id, {
    controllerNodeId: "node-a",
    targetRef: "node-b",
  });
  const r = requestChannelRevocation(d, c.id);
  expect(r.needsReconcile).toBe(false);
  const obs = getSiteChannelObservation(d, c.id);
  expect(obs?.status).toBe("cleanup_pending");
  expect(obs?.lastError).toContain("控制设备");
});

test("revoking the LAST public channel dual-writes the legacy register private", () => {
  const d = node("node-a");
  const site = createSite(d, { name: "s4", visibility: "public" });
  const c = mkChannel(d, site.id, {
    audience: "public",
    targetRef: "node-a",
    policy: { v: 1, tables: [] },
  });
  requestChannelRevocation(d, c.id);
  expect(
    (d.query("SELECT visibility FROM sites WHERE id = ?").get(site.id) as { visibility: string })
      .visibility,
  ).toBe("private");
  expect(sitePublicAccessState(d, site).configured).toBe(false);
});

test("revoking one of several public channels keeps the register public", () => {
  const d = node("node-a");
  const site = createSite(d, { name: "s5", visibility: "public" });
  const c1 = mkChannel(d, site.id, {
    audience: "public",
    targetRef: "node-a",
    policy: { v: 1, tables: [] },
  });
  mkChannel(d, site.id, {
    audience: "public",
    targetRef: "node-b",
    policy: { v: 1, tables: [] },
  });
  requestChannelRevocation(d, c1.id);
  expect(
    (d.query("SELECT visibility FROM sites WHERE id = ?").get(site.id) as { visibility: string })
      .visibility,
  ).toBe("public");
  expect(sitePublicAccessState(d, site).configured).toBe(true);
});
