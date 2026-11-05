import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openMetahub } from "../db.ts";
import { createDocument, getDocument } from "../documents.ts";
import { putBlob } from "../cache.ts";
import { createDraftStore } from "../replica/drafts.ts";
import { addStoragePeer, getPeer } from "./peers.ts";
import { rebuildDesktopReplica } from "./recovery-desktop.ts";
import { recoveryItems } from "./recovery-v2.ts";
import { MhError } from "../errors.ts";
import type { StorageClient, StorageReadResult } from "./storage.ts";

test("desktop rebuild protects the live WAL database and cache, switches on reopen, and rolls back failed protection", async () => {
  const previous = process.env.METAHUB_HOME;
  const home = mkdtempSync(join(tmpdir(), "mh-desktop-rebuild-"));
  process.env.METAHUB_HOME = home;
  const objects = new Map<string, StorageReadResult>();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => [],
    get: async (key) => objects.get(key)?.bytes ?? null,
    getWithMetadata: async (key) => objects.get(key) ?? null,
    put: async (key, bytes, options) => {
      if (options?.ifNoneMatch && objects.has(key))
        throw new MhError("conflict", "occupied");
      const now = Date.now();
      objects.set(key, {
        bytes,
        lastModified: now,
        serverDate: now,
        etag: null,
      });
    },
    del: async () => {
      throw new Error("unexpected remote delete");
    },
  };
  try {
    const source = openMetahub();
    const url = "s3://synthetic.invalid/bucket/fixture";
    const config = {
      endpoint: "https://synthetic.invalid",
      region: "test",
      bucket: "bucket",
      prefix: "fixture",
      encrypt: false,
      accessKeyId: "test",
      secretAccessKey: "test",
    };
    addStoragePeer(source, { url, config });
    const blob = await putBlob("pending attachment");
    const doc = createDocument(source, {
      title: "original",
      body: `![pending](/blob/${blob.hash})`,
    });
    createDraftStore(source).checkpointDocument(doc.id, {
      revision: 1,
      title: "draft",
      body: "offline draft",
      version: null,
    });
    const bad = join(home, "cache", "0".repeat(32));
    await Bun.write(bad, "invalid bytes");
    await expect(rebuildDesktopReplica(url, client)).rejects.toThrow(
      "Attachment protection",
    );
    expect(objects.size).toBe(0);
    const unchanged = openMetahub();
    expect(unchanged.filename).toBe(source.filename);
    unchanged.close();
    await Bun.file(bad).delete();
    const result = await rebuildDesktopReplica(url, client);
    const active = openMetahub();
    try {
      expect(active.filename).not.toBe(source.filename);
      expect(getDocument(active, doc.id)?.body).toContain(blob.hash);
      expect(getPeer(active, url)?.push_cursor).toBe(0);
      expect(
        recoveryItems(active).some((item) =>
          item.local.includes("offline draft"),
        ),
      ).toBe(true);
      expect(() => createDocument(source, { title: "stale writer" })).toThrow(
        "reopen",
      );
      const backup = new Database(
        join(home, "recovery", result.packageId, "original.db"),
        { readonly: true },
      );
      try {
        expect(getDocument(backup, doc.id)?.title).toBe("original");
      } finally {
        backup.close();
      }
      expect(
        await Bun.file(
          join(home, "recovery", result.packageId, blob.hash),
        ).text(),
      ).toBe("pending attachment");
    } finally {
      active.close();
      source.close();
    }
  } finally {
    if (previous === undefined) delete process.env.METAHUB_HOME;
    else process.env.METAHUB_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
