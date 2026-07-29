import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { changesAfterSeq, ingest } from "./crdt.ts";
import {
  initSchema,
  migrateSiteChannels,
  runSchema,
} from "./schema-init.ts";
import { createSite, deleteSite, updateSite } from "./sites-core.ts";
import {
  isSitePublicConfigured,
  isSitePublicOnThisNode,
  listSiteChannelRows,
  listSiteChannelViews,
  putSiteChannel,
  putSiteChannelObservation,
  setPublicSiteChannelPolicies,
  setSiteChannelDesiredState,
  updatePublicSiteChannelUrls,
} from "./site-channel-store.ts";
import { reconcileSiteChannels } from "./sync/site-channel-reconcile.ts";
import { createShare, getShare } from "./shares.ts";

function node(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key,value) VALUES ('node_id',?)").run(id);
  return db;
}

test("a public channel serves only on its target node and revocation converges", () => {
  const a = node("node-a");
  const b = node("node-b");
  const site = createSite(a, { name: "demo" });
  updateSite(a, site.id, { visibility: "public" }); // legacy dual-write
  const channel = putSiteChannel(a, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    controllerNodeId: "node-b",
    targetRef: "node-b",
    canonicalUrl: "https://b.example/sites/demo/",
    policy: { v: 1, tables: [] },
  });
  putSiteChannelObservation(a, {
    channelId: channel.id,
    status: "ready",
    lastVerifiedAt: 123,
  });

  const first = changesAfterSeq(a, 0);
  ingest(b, first.changes);
  expect(isSitePublicConfigured(a, site)).toBe(true);
  expect(isSitePublicOnThisNode(a, site)).toBe(false);
  const remoteSite = b
    .query("SELECT id,visibility FROM sites WHERE id = ?")
    .get(site.id) as { id: string; visibility: string };
  expect(isSitePublicOnThisNode(b, remoteSite)).toBe(true);
  // Readiness is node-local; B knows the desired URL but does not fabricate A's
  // successful observation as its own.
  expect(listSiteChannelViews(b, site.id)[0]!.status).toBe("unverified");

  setSiteChannelDesiredState(a, channel.id, "revoked");
  // A stale local "ready" observation must never override the synced desired
  // revocation. A waits for B; B is the target and knows serving stopped.
  expect(listSiteChannelViews(a, site.id)[0]!.status).toBe(
    "waiting_controller",
  );
  ingest(b, changesAfterSeq(a, first.cursor).changes);
  expect(isSitePublicConfigured(b, remoteSite)).toBe(false);
  expect(isSitePublicOnThisNode(b, remoteSite)).toBe(false);
  expect(listSiteChannelViews(b, site.id)[0]!.status).toBe("revoked");
});

test("grant edits and site renames update live public channel metadata", () => {
  const d = node("node-a");
  const site = createSite(d, { name: "before" });
  const channel = putSiteChannel(d, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    targetRef: "node-a",
    canonicalUrl: "https://example.test/sites/before/?old=1#old",
    policy: { v: 1, tables: [] },
  });
  setPublicSiteChannelPolicies(d, site.id, {
    v: 1,
    tables: [{ db: "db_x", ops: ["read"] }],
  });
  updatePublicSiteChannelUrls(d, site.id, "after");
  expect(listSiteChannelRows(d, site.id)).toEqual([
    expect.objectContaining({
      id: channel.id,
      canonical_url: "https://example.test/sites/after/",
      policy_json: JSON.stringify({
        v: 1,
        tables: [{ db: "db_x", ops: ["read"] }],
      }),
    }),
  ]);
});

test("malformed v2 rows disable legacy public fallback", () => {
  const d = node("node-a");
  const site = createSite(d, {
    name: "legacy-public",
    visibility: "public",
  });
  d.query(
    `INSERT INTO site_channels
       (id,site_id,audience,hosting,controller_node_id,target_ref,desired_state,created_hlc)
     VALUES ('chan_bad',?,'future-audience','device','node-a','node-a','active','1')`,
  ).run(site.id);
  expect(isSitePublicOnThisNode(d, site)).toBe(false);
  expect(listSiteChannelRows(d, site.id)).toEqual([]);
});

test("reconciler revokes an orphaned link left by an older site delete", async () => {
  const d = node("node-a");
  const site = createSite(d, { name: "old-client-delete" });
  const share = createShare(d, {
    kind: "site",
    target_id: site.id,
    permission: "view",
  });
  const channel = putSiteChannel(d, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://local.test/share/${share.slug}`,
  });
  // Simulate a pre-channel client that knows only the site tombstone.
  deleteSite(d, site.id);
  await reconcileSiteChannels(d);
  expect(getShare(d, share.slug)).toBeNull();
  expect(listSiteChannelRows(d, site.id)[0]).toMatchObject({
    id: channel.id,
    desired_state: "revoked",
  });
  expect(listSiteChannelViews(d, site.id)[0]!.status).toBe("revoked");
});

test("upgrade re-materializes site_channels changes retained by an old client", () => {
  const db = new Database(":memory:");
  runSchema(db);
  db.exec("DROP TABLE site_channels");
  const insert = db.query(
    `INSERT INTO crdt_changes
       (hlc,node_id,dataset,row_id,col,value)
     VALUES (?, 'newer', 'site_channels', 'chan_x', ?, ?)`,
  );
  const fields: [string, unknown][] = [
    ["site_id", "site_x"],
    ["audience", "link"],
    ["hosting", "edge"],
    ["controller_node_id", "newer"],
    ["target_ref", "secret-slug"],
    ["canonical_url", "https://edge.example/room/secret-slug"],
    ["desired_state", "active"],
    ["created_hlc", "0001-newer"],
  ];
  fields.forEach(([col, value], i) =>
    insert.run(`000000000000${String(i).padStart(2, "0")}-newer`, col, JSON.stringify(value)),
  );

  runSchema(db); // upgraded binary creates the materialized table
  migrateSiteChannels(db);
  expect(listSiteChannelRows(db)).toEqual([
    expect.objectContaining({
      id: "chan_x",
      audience: "link",
      hosting: "edge",
      desired_state: "active",
    }),
  ]);
});

test("upgrade fills retained channels even when older materialized rows exist", () => {
  const db = node("node-a");
  const site = createSite(db, { name: "mixed-upgrade" });
  const existing = putSiteChannel(db, {
    siteId: site.id,
    audience: "public",
    hosting: "device",
    targetRef: "node-a",
  });
  const retained = putSiteChannel(db, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: "retained-share",
  });
  // A downgraded client keeps the unknown dataset in its oplog but cannot
  // materialize the newer row. Preserve one older row so this covers the
  // partially-populated upgrade, not only the empty-table case above.
  db.query("DELETE FROM site_channels WHERE id = ?").run(retained.id);
  expect(listSiteChannelRows(db).map((row) => row.id)).toEqual([existing.id]);

  migrateSiteChannels(db);

  expect(listSiteChannelRows(db).map((row) => row.id).sort()).toEqual(
    [existing.id, retained.id].sort(),
  );
});
