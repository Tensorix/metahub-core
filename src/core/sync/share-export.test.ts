import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../schema-init.ts";
import { createDocument } from "../documents.ts";
import { errorCode } from "../errors.ts";
import { setBlobBytesResolver, recordBlob } from "../blobs-core.ts";
import { resolveBlob } from "../blobs.ts";
import { decryptBytes, fromB64 } from "./e2ee.ts";
import {
  createBucketShare,
  refreshManifestUrls,
  type ShareManifest,
} from "./share-export.ts";
import {
  setStorageClientFactory,
  type S3Config,
  type StorageClient,
} from "./storage.ts";

test("refreshManifestUrls swaps ONLY the presigned URLs, content untouched", async () => {
  const manifest: ShareManifest = {
    v: 1,
    kind: "doc",
    title: "Spec",
    body: "hello ![](blob/aaaa1111aaaa1111) world",
    blobs: {
      aaaa1111aaaa1111: { url: "https://old.example/a?sig=1", ct: "image/png" },
      bbbb2222bbbb2222: { url: "https://old.example/b?sig=2", ct: "image/jpeg" },
    },
  };
  const out = await refreshManifestUrls(manifest, async (hash) => `https://new.example/${hash}?sig=9`);
  expect(out.body).toBe(manifest.body);
  expect(out.title).toBe("Spec");
  expect(out.blobs!.aaaa1111aaaa1111).toEqual({
    url: "https://new.example/aaaa1111aaaa1111?sig=9",
    ct: "image/png",
  });
  expect(out.blobs!.bbbb2222bbbb2222!.ct).toBe("image/jpeg");
  // Input not mutated.
  expect(manifest.blobs!.aaaa1111aaaa1111!.url).toBe("https://old.example/a?sig=1");
});

test("refreshManifestUrls is a no-op for manifests without blobs", async () => {
  const manifest: ShareManifest = { v: 1, kind: "database", title: "T", records: [] };
  const out = await refreshManifestUrls(manifest, async () => {
    throw new Error("must not be called");
  });
  expect(out).toBe(manifest);
});

// ---- blob bytes come through the runtime seam (blobs-core.ts) ------------------
// share-export.ts is loaded by BOTH the server and the browser replica, so it must
// not import blobs.ts (node:fs / Bun.file). It asks whichever resolver the runtime
// registered — Bun's resolveBlob, or the browser worker's spool→bucket resolver.

const HASH = "aaaa1111aaaa1111aaaa1111aaaa1111"; // canonical 32-hex
const CONFIG = {
  endpoint: "https://x.example",
  bucket: "b",
  prefix: "metahub",
  region: "auto",
  accessKeyId: "ak",
  secretAccessKey: "sk",
} as S3Config;

function memoryStore(): { store: Map<string, Uint8Array>; client: StorageClient } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    client: {
      list: async () => [],
      get: async (k) => store.get(k) ?? null,
      put: async (k, b) => void store.set(k, b),
      del: async (k) => void store.delete(k),
    },
  };
}

function docWithBlob(): { db: Database; targetId: string } {
  const db = new Database(":memory:");
  initSchema(db as never);
  const doc = createDocument(db as never, { title: "Pics", body: `see ![](/blob/${HASH})` });
  recordBlob(db as never, HASH, 3, "image/png", 0);
  return { db, targetId: doc.id };
}

test("bucket share resolves blob bytes through the registered resolver", async () => {
  const { db, targetId } = docWithBlob();
  const { store, client } = memoryStore();
  const bytes = new Uint8Array([7, 8, 9]);
  try {
    setStorageClientFactory(() => client);
    setBlobBytesResolver(async (_db, hash) => (hash === HASH ? bytes : null));
    const link = await createBucketShare(db as never, {
      slug: "s1",
      kind: "doc",
      targetId,
      config: CONFIG,
      expiresSec: 3600,
    });

    // The blob was uploaded (encrypted) under the share's own prefix...
    const shareKey = fromB64(link.keyB64!);
    const blobBody = store.get(`metahub/shares/s1/blobs/${HASH}`);
    expect(blobBody).toBeDefined();
    expect(await decryptBytes(shareKey, blobBody!)).toEqual(bytes);

    // ...and the manifest points at a presigned GET for it, tagged with its type.
    const manifestBody = store.get("metahub/shares/s1/manifest.bin");
    expect(manifestBody).toBeDefined();
    const manifest = JSON.parse(
      new TextDecoder().decode(await decryptBytes(shareKey, manifestBody!)),
    ) as ShareManifest;
    expect(manifest.blobs![HASH]!.ct).toBe("image/png");
    expect(manifest.blobs![HASH]!.url).toContain("X-Amz-Signature");
  } finally {
    setBlobBytesResolver(resolveBlob); // restore the real Bun resolver
  }
});

test("bucket share with referenced blobs fails loudly when no resolver is registered", async () => {
  const { db, targetId } = docWithBlob();
  const { client } = memoryStore();
  try {
    setStorageClientFactory(() => client);
    // A runtime that never wired the seam would otherwise read as "every blob is
    // unreachable" and quietly ship a share with broken images.
    setBlobBytesResolver(null);
    let thrown: unknown;
    try {
      await createBucketShare(db as never, {
        slug: "s2",
        kind: "doc",
        targetId,
        config: CONFIG,
        expiresSec: 3600,
      });
    } catch (e) {
      thrown = e;
    }
    expect(errorCode(thrown)).toBe("network");
    expect((thrown as Error).message).toContain("blob-bytes resolver");
  } finally {
    setBlobBytesResolver(resolveBlob);
  }
});
