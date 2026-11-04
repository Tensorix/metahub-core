import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { createSite, deleteSite } from "../../../../../src/core/sites-core.ts";
import {
  putSiteChannel,
  setSiteChannelDesiredState,
} from "../../../../../src/core/site-channel-store.ts";
import { mobileSites, safeSiteUrl } from "./sites";

test("Site opening never turns private replicas or unsafe channels into public links", () => {
  const db = new Database(":memory:");
  try {
    initSchema(db);
    const privateSite = createSite(db, { name: "private" });
    const publicSite = createSite(db, { name: "public", visibility: "public" });
    expect(
      mobileSites(db, "https://workspace.example").find(
        (s) => s.id === privateSite.id,
      )?.url,
    ).toBeNull();
    expect(
      mobileSites(db, "https://workspace.example").find(
        (s) => s.id === publicSite.id,
      )?.url,
    ).toBe("https://workspace.example/sites/public/");
    expect(mobileSites(db).every((s) => !s.url)).toBe(true);
    const channel = putSiteChannel(db, {
      siteId: publicSite.id,
      audience: "public",
      hosting: "edge",
      controllerNodeId: "test",
      targetRef: "test",
      canonicalUrl: "https://published.example/sites/public/",
    });
    expect(mobileSites(db).find((s) => s.id === publicSite.id)?.url).toBe(
      "https://published.example/sites/public/",
    );
    setSiteChannelDesiredState(db, channel.id, "revoked");
    expect(mobileSites(db).find((s) => s.id === publicSite.id)?.url).toBeNull();
    deleteSite(db, publicSite.id);
    expect(mobileSites(db).map((s) => s.id)).toEqual([privateSite.id]);
  } finally {
    db.close();
  }
});

test("Site navigation rejects executable schemes and URL credentials", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///private/data",
    "https://secret:token@example.com",
    "data:text/html,test",
    "invalid",
  ])
    expect(safeSiteUrl(url)).toBeNull();
  expect(safeSiteUrl("https://example.com/app/")).toBe(
    "https://example.com/app/",
  );
});
