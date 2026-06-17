import { test, expect } from "bun:test";
import { blobHash32, verifyBytes, inferBlobType, extForType, isPoisonContentType } from "./blob-store.ts";
import { blobHash, verifyBlobBytes } from "../../core/cache.ts";

// The offline-composed URL /blob/<hash> must match what the server would assign,
// or an image saved offline would point at a different hash once uploaded.
test("blobHash32 matches the server's blobHash for the same bytes", async () => {
  for (const sample of [new Uint8Array([]), new Uint8Array([1, 2, 3]), new Uint8Array(1000).fill(7)]) {
    expect(await blobHash32(sample)).toBe(blobHash(sample));
  }
});

test("blobHash32 accepts an ArrayBuffer too", async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  expect(await blobHash32(bytes.buffer)).toBe(blobHash(bytes));
});

test("verifyBytes agrees with core verifyBlobBytes (32- and 64-hex)", async () => {
  const bytes = new Uint8Array([4, 2, 0, 6, 9]);
  const h32 = blobHash(bytes); // 32 hex
  expect(await verifyBytes(bytes, h32)).toBe(true);
  expect(verifyBlobBytes(bytes, h32)).toBe(true);
  expect(await verifyBytes(new Uint8Array([4, 2, 0]), h32)).toBe(false);
});

// cacheGet's read-side self-heal: the historical poison (SPA-fallback index.html,
// unlock/login page, captive-portal interstitial, CDN 200 error page) is always
// text/html. Such a hit is purged and reported as a miss so an already-poisoned
// device recovers without clearing storage (the refetch goes through the now
// hash-verified write path). Scoped to text/html — /blob is a general large-file
// endpoint, so legit text/css|javascript|plain|markdown blobs must NOT be purged.
test("isPoisonContentType flags text/html (the real poison) only", () => {
  expect(isPoisonContentType("text/html")).toBe(true);
  expect(isPoisonContentType("text/html; charset=utf-8")).toBe(true);
  expect(isPoisonContentType("  TEXT/HTML  ")).toBe(true);
  expect(isPoisonContentType("text/plain")).toBe(false); // legit large-file blobs stay cacheable
  expect(isPoisonContentType("text/css")).toBe(false);
  expect(isPoisonContentType("text/javascript")).toBe(false);
  expect(isPoisonContentType("text/markdown")).toBe(false);
  expect(isPoisonContentType("image/png")).toBe(false);
  expect(isPoisonContentType("application/pdf")).toBe(false);
  expect(isPoisonContentType("application/octet-stream")).toBe(false);
  expect(isPoisonContentType("")).toBe(false);
});

test("content-type inference + extension round-trip", () => {
  expect(inferBlobType("a.png")).toBe("image/png");
  expect(inferBlobType("/blob/abc.jpg")).toBe("image/jpeg");
  expect(inferBlobType("noext")).toBe("application/octet-stream");
  expect(extForType("image/png")).toBe("png");
  expect(extForType("image/jpeg")).toBe("jpg"); // not "jpeg"
  expect(extForType("application/octet-stream")).toBe("");
});
