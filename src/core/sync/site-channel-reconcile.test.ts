import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { changesAfterSeq, ingest } from "../crdt.ts";
import { initSchema } from "../schema-init.ts";
import { createSite, deleteSite, siteLifecycle } from "../sites-core.ts";
import {
  getSiteChannelObservation,
  listSiteChannelRows,
  listSiteChannelViews,
  putSiteChannel,
  putSiteChannelObservation,
  setSiteChannelDesiredState,
} from "../site-channel-store.ts";
import { createShare, deleteShare, getShare } from "../shares.ts";
import {
  CONTROLLER_STATE_MISSING,
  reconcileSiteChannels,
} from "./site-channel-reconcile.ts";

function node(id: string): Database {
  const db = new Database(":memory:");
  initSchema(db);
  db.query("INSERT INTO meta (key,value) VALUES ('node_id',?)").run(id);
  return db;
}

function siteChannelChanges(db: Database) {
  return changesAfterSeq(db, 0).changes.filter((c) => c.dataset === "site_channels");
}

function oplogCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM crdt_changes").get() as { n: number }).n;
}

test("a channel that replicates before its site row is NOT revoked", async () => {
  const b = node("node-b");
  const site = createSite(b, { name: "early-channel" });
  const share = createShare(b, { kind: "site", target_id: site.id, permission: "view" });
  putSiteChannel(b, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://b.test/share/${share.slug}`,
  });

  // Node C receives only the site_channels stream — the sites row lags behind.
  const c = node("node-c");
  ingest(c, siteChannelChanges(b));
  expect(siteLifecycle(c, site.id)).toBe("absent");

  const before = oplogCount(c);
  await reconcileSiteChannels(c);
  expect(listSiteChannelRows(c, site.id)[0]!.desired_state).toBe("active");
  expect(oplogCount(c)).toBe(before); // no revoke emitted, nothing to sync back

  // Once the site row catches up the channel keeps working.
  ingest(c, changesAfterSeq(b, 0).changes);
  await reconcileSiteChannels(c);
  expect(listSiteChannelRows(c, site.id)[0]!.desired_state).toBe("active");
});

test("a replicated site tombstone revokes channels exactly once (idempotent)", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "tombstoned" });
  const share = createShare(a, { kind: "site", target_id: site.id, permission: "view" });
  putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://a.test/share/${share.slug}`,
  });
  deleteSite(a, site.id);
  expect(siteLifecycle(a, site.id)).toBe("tombstoned");

  await reconcileSiteChannels(a);
  expect(listSiteChannelRows(a, site.id)[0]!.desired_state).toBe("revoked");
  expect(getShare(a, share.slug)).toBeNull();

  const after = oplogCount(a);
  await reconcileSiteChannels(a);
  expect(oplogCount(a)).toBe(after); // second run emits nothing new
});

test("a missing controller share row is an error observation, not a revocation", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "lost-secret" });
  const share = createShare(a, { kind: "site", target_id: site.id, permission: "view" });
  const channel = putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://a.test/share/${share.slug}`,
  });
  // Simulate local damage: the node-local secret row vanishes (bad restore).
  const saved = a.query("SELECT * FROM shares WHERE slug = ?").get(share.slug) as Record<
    string,
    unknown
  >;
  deleteShare(a, share.slug);

  const before = oplogCount(a);
  await reconcileSiteChannels(a);
  expect(listSiteChannelRows(a, site.id)[0]!.desired_state).toBe("active");
  expect(oplogCount(a)).toBe(before); // nothing replicated
  const obs = getSiteChannelObservation(a, channel.id);
  expect(obs?.status).toBe("error");
  expect(obs?.lastError).toStartWith(CONTROLLER_STATE_MISSING);
  // The channel stays visible as errored — never silently dropped.
  expect(listSiteChannelViews(a, site.id)[0]!.status).toBe("error");

  // Self-heal: the share row reappearing clears the observation.
  const cols = Object.keys(saved);
  a.query(
    `INSERT INTO shares (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...(cols.map((k) => saved[k]) as never[]));
  await reconcileSiteChannels(a);
  expect(getSiteChannelObservation(a, channel.id)).toBeNull();
});

test("an expired share survives reconcile: no revoke, no delete", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "expired-link" });
  const share = createShare(a, {
    kind: "site",
    target_id: site.id,
    permission: "view",
    expiresAt: Date.now() - 60_000,
  });
  putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://a.test/share/${share.slug}`,
  });

  const before = oplogCount(a);
  await reconcileSiteChannels(a);
  expect(getShare(a, share.slug)).not.toBeNull();
  expect(listSiteChannelRows(a, site.id)[0]!.desired_state).toBe("active");
  expect(oplogCount(a)).toBe(before);
});

test("edge revoke without a local Room record stays cleanup_pending, share intact", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "edge-absent" });
  const share = createShare(a, { kind: "site", target_id: site.id, permission: "view" });
  const channel = putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "edge",
    targetRef: share.slug,
    canonicalUrl: `https://edge.test/r/${share.slug}`,
  });
  setSiteChannelDesiredState(a, channel.id, "revoked");

  await reconcileSiteChannels(a);
  // No room peer row exists → teardown returns "absent": destruction is
  // unconfirmed, so the share must survive and the status must not claim
  // the Edge copy is gone.
  expect(getShare(a, share.slug)).not.toBeNull();
  const obs = getSiteChannelObservation(a, channel.id);
  expect(obs?.status).toBe("cleanup_pending");
});

test("a confirmed edge destroy is terminal: later reconciles keep 'revoked'", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "edge-destroyed" });
  const channel = putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "edge",
    targetRef: "slug-already-destroyed",
    canonicalUrl: "https://edge.test/r/slug-already-destroyed",
  });
  setSiteChannelDesiredState(a, channel.id, "revoked");
  // State after a successful teardown: Room destroyed (peer row removed), share
  // deleted, observation revoked.
  putSiteChannelObservation(a, {
    channelId: channel.id,
    status: "revoked",
    lastVerifiedAt: Date.now(),
  });

  await reconcileSiteChannels(a);
  await reconcileSiteChannels(a);
  // A second teardown attempt would report "absent" and demote this to
  // cleanup_pending forever ("撤销已请求，等待…" reappearing after every sync).
  expect(getSiteChannelObservation(a, channel.id)?.status).toBe("revoked");
});

test("the terminal guard is edge-only: a device revoke still deletes its share", async () => {
  const a = node("node-a");
  const site = createSite(a, { name: "device-revoke" });
  const share = createShare(a, { kind: "site", target_id: site.id, permission: "view" });
  const channel = putSiteChannel(a, {
    siteId: site.id,
    audience: "link",
    hosting: "device",
    targetRef: share.slug,
    canonicalUrl: `http://a.test/share/${share.slug}`,
  });
  // requestChannelRevocation records "revoked" up front for a channel served by
  // THIS device — the share row is still here and must still be removed.
  setSiteChannelDesiredState(a, channel.id, "revoked");
  putSiteChannelObservation(a, {
    channelId: channel.id,
    status: "revoked",
    lastVerifiedAt: Date.now(),
  });

  await reconcileSiteChannels(a);
  expect(getShare(a, share.slug)).toBeNull();
});
