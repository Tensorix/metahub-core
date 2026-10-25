import { expect, test } from "bun:test";
import { nativeStorageCodec } from "./codec";
import { decryptBytes, encryptBytes, generateMasterKey } from "../../../../../src/core/sync/e2ee.ts";

async function browserTransform(bytes: Uint8Array, decompress: boolean): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes);
  const stream = new Response(copy.buffer).body!.pipeThrough(
    decompress ? new DecompressionStream("gzip") : new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("native gzip and browser streams exchange encrypted JSONL in both directions", async () => {
  const bytes = new TextEncoder().encode(Array.from({ length: 5000 }, (_, i) =>
    JSON.stringify({ hlc: `${i}`, value: "跨设备 ⇄ mobile 🗂️", row_id: `record-${i}` }),
  ).join("\n"));
  const key = generateMasterKey();
  const nativePayload = await encryptBytes(key, await nativeStorageCodec.gzip(bytes));
  expect(await browserTransform(await decryptBytes(key, nativePayload), true)).toEqual(bytes);
  const browserPayload = await encryptBytes(key, await browserTransform(bytes, false));
  expect(await nativeStorageCodec.gunzip(await decryptBytes(key, browserPayload))).toEqual(bytes);
});

test("native codec handles empty segments and rejects corrupt gzip", async () => {
  const bytes = new Uint8Array();
  expect(await nativeStorageCodec.gunzip(await nativeStorageCodec.gzip(bytes))).toEqual(bytes);
  await expect(nativeStorageCodec.gunzip(new Uint8Array([1, 2, 3]))).rejects.toThrow();
});
