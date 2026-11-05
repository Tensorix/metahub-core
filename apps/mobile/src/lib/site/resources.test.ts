import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init";
import {
  createSite,
  writeFileRow,
  deleteFile,
} from "../../../../../src/core/sites-core";
import { createAttachmentStore } from "../attachments/store";
import { createSiteResources } from "./resources";

test("preparation retries missing bytes, shares one download, and prunes after the last reference", async () => {
  const db = new Database(":memory:");
  initSchema(db);
  const store = createAttachmentStore(db);
  const hash = "a".repeat(32);
  const a = createSite(db, { name: "first" }),
    b = createSite(db, { name: "second" });
  for (const site of [a, b])
    writeFileRow(db, site.id, "logo.png", "image/png", "blob", hash);
  let attempts = 0,
    exists = false;
  const resources = createSiteResources(
    db,
    {
      async cache(src) {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        exists = true;
        store.put({
          src,
          hash,
          name: "logo",
          mime: "image/png",
          uri: "test",
          pending: 0,
          pinned: 1,
          size: 1,
          error: null,
        });
        return { name: "logo", size: 1 };
      },
    },
    () => true,
    () => ({
      exists,
      size: 1,
      modificationTime: 1,
      delete() {
        exists = false;
      },
    }),
  );
  try {
    await resources.prepare();
    expect(resources.missing(a.id)).toEqual([
      { path: "logo.png", error: "offline" },
    ]);
    await resources.prepare();
    expect(attempts).toBe(2);
    expect(resources.missing(b.id)).toEqual([]);
    exists = false;
    expect(resources.missing(b.id)).toEqual([
      { path: "logo.png", error: undefined },
    ]);
    await resources.prepare();
    expect(attempts).toBe(3);
    expect(resources.missing(b.id)).toEqual([]);
    deleteFile(db, a.id, "logo.png");
    await resources.prepare();
    expect(exists).toBe(true);
    deleteFile(db, b.id, "logo.png");
    await resources.prepare();
    expect(exists).toBe(false);
    expect(store.list()).toEqual([]);
  } finally {
    db.close();
  }
});
