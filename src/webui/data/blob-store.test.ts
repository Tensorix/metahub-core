import { test, expect } from "bun:test";
import { blobHash32, verifyBytes, inferBlobType, extForType } from "./blob-store.ts";
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

test("content-type inference + extension round-trip", () => {
  expect(inferBlobType("a.png")).toBe("image/png");
  expect(inferBlobType("/blob/abc.jpg")).toBe("image/jpeg");
  expect(inferBlobType("noext")).toBe("application/octet-stream");
  expect(extForType("image/png")).toBe("png");
  expect(extForType("image/jpeg")).toBe("jpg"); // not "jpeg"
  expect(extForType("application/octet-stream")).toBe("");
});
