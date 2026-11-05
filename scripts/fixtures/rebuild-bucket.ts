import { Database } from "bun:sqlite";
import { initSchema } from "../../src/core/schema-init.ts";
import { captureDocumentArchive } from "../../src/core/history-archive.ts";
import {
  createDocument,
  updateDocument,
  documentVersion,
} from "../../src/core/documents.ts";
import { createV2Bucket } from "../../src/core/sync/bucket-v2.ts";
import { captureCurrentCheckpoint } from "../../src/core/sync/current-checkpoint.ts";
import type { StorageClient } from "../../src/core/sync/storage.ts";

export async function syntheticCheckpoint() {
  const objects = new Map<string, Uint8Array>();
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => [],
    get: async (key) => objects.get(key) ?? null,
    getWithMetadata: async (key) =>
      objects.has(key)
        ? {
            bytes: objects.get(key)!,
            lastModified: Date.now(),
            serverDate: Date.now(),
            etag: null,
          }
        : null,
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    del: async () => {
      throw new Error("unexpected delete");
    },
  };
  const db = new Database(":memory:");
  try {
    initSchema(db);
    const cloud = createDocument(db, { title: "cloud", body: "cloud history" });
    const version = documentVersion(db, cloud.id);
    updateDocument(db, cloud.id, { body: "cloud checkpoint" });
    const bucket = createV2Bucket(client, {
      endpoint: "https://fixture.invalid",
      region: "test",
      bucket: "synthetic",
      prefix: "fixture",
      encrypt: false,
      accessKeyId: "test",
      secretAccessKey: "test",
    });
    const checkpoint = captureCurrentCheckpoint(db, "fixture-workspace", 0);
    const hash = await bucket.publish(
      captureDocumentArchive(db, "fixture-workspace", cloud.id),
    );
    checkpoint.history.push({ documentId: cloud.id, hash });
    const root = await bucket.initialize(checkpoint);
    let checkpointBarrier: (() => Promise<void>) | undefined;
    const history = { available: true, reads: 0 };
    return {
      cloud,
      version,
      history,
      holdNextCheckpoint() {
        let signal!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          signal = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        checkpointBarrier = async () => {
          signal();
          await released;
        };
        return { started, release };
      },
      async fetch(req: Request) {
        const path = new URL(req.url).pathname;
        const key = path.slice("/synthetic/".length);
        if (key === bucket.objectKey(root.checkpoint) && checkpointBarrier) {
          const barrier = checkpointBarrier;
          checkpointBarrier = undefined;
          await barrier();
        }
        if (key === bucket.objectKey(hash)) {
          history.reads++;
          if (!history.available)
            return new Response("temporarily missing", { status: 404 });
        }
        const bytes = objects.get(key);
        if (path.startsWith("/synthetic/") && bytes && req.method === "GET")
          return new Response(bytes, {
            headers: {
              "last-modified": new Date(1000).toUTCString(),
              date: new Date().toUTCString(),
            },
          });
        return new Response("missing", { status: 404 });
      },
    };
  } finally {
    db.close();
  }
}
