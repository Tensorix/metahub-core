import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init";
import { createSite, getSite } from "../sites-core";
import { createReplicaService, type ReplicaChange } from "./service";

test("site configuration emits sync changes without changing publication access", () => {
  const db = new Database(":memory:");
  try {
    initSchema(db);
    const site = createSite(db, { name: "original", visibility: "private" });
    const changes: ReplicaChange[] = [];
    const service = createReplicaService(db, { onChange: change => changes.push(change) });
    service.dispatch("updateSiteConfiguration", [site.id, { title: "Budget", name: "budget", spa: true }]);
    expect(getSite(db, site.id)).toMatchObject({ title: "Budget", name: "budget", spa: 1, visibility: "private" });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.datasets).toContain("sites");
    service.pauseMutations(true);
    expect(() => service.dispatch("updateSiteConfiguration", [site.id, { title: "Blocked" }])).toThrow();
    expect(getSite(db, site.id)?.title).toBe("Budget");
    service.dispose();
  } finally { db.close(); }
});

test("duplicate slugs reject the entire configuration edit", () => {
  const db = new Database(":memory:");
  try {
    initSchema(db);
    const site = createSite(db, { name: "first", title: "Original" });
    createSite(db, { name: "taken" });
    const service = createReplicaService(db);
    expect(() => service.dispatch("updateSiteConfiguration", [site.id, { name: "taken", title: "Changed", spa: true }])).toThrow();
    expect(getSite(db, site.id)).toMatchObject({ name: "first", title: "Original", spa: 0 });
    service.dispose();
  } finally { db.close(); }
});
