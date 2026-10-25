import { Gzip, Gunzip } from "fflate";
import type { StorageCompressionCodec } from "../../../../../src/core/sync/storage.ts";

const CHUNK_BYTES = 64 * 1024;

/** Feed bounded chunks and yield between them so a large snapshot does not
 * monopolize the native JS thread. fflate workers require Web Workers, which
 * Hermes does not provide. The bytes remain standard RFC 1952 gzip. */
async function transform(bytes: Uint8Array, decompress: boolean): Promise<Uint8Array> {
  if (decompress && (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3]! & 0xe0)))
    throw new Error("Invalid gzip segment");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const ondata = (chunk: Uint8Array) => {
    chunks.push(chunk);
    size += chunk.byteLength;
  };
  const stream = decompress ? new Gunzip(ondata) : new Gzip({ mtime: 0 }, ondata);
  if (bytes.length === 0) stream.push(bytes, true);
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.length);
    stream.push(bytes.subarray(offset, end), end === bytes.length);
    if (end < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export const nativeStorageCodec: StorageCompressionCodec = {
  gzip: (bytes) => transform(bytes, false),
  gunzip: (bytes) => transform(bytes, true),
};
