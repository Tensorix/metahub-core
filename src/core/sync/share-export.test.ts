import { test, expect } from "bun:test";
import { refreshManifestUrls, type ShareManifest } from "./share-export.ts";

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
