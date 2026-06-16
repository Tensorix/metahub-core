import { join } from "node:path";
import { cacheDir } from "./paths.ts";

export interface BlobInfo {
  hash: string;
  path: string;
  size: number;
}

export function blobPath(hash: string): string {
  return join(cacheDir(), hash);
}

/** Content key length: sha256 truncated to 128 bits (32 hex). Shorter keys keep
 *  doc markdown (`![](/blob/<hash>.png)`) readable; collision is negligible.
 *  Addressing stays length-agnostic, so legacy full 64-hex refs still resolve. */
export const BLOB_HASH_HEX = 32;

/** Full sha256 hex of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** Canonical content hash for new blobs: sha256 of the bytes, truncated. */
export function blobHash(bytes: Uint8Array): string {
  return sha256Hex(bytes).slice(0, BLOB_HASH_HEX);
}

/** Verify fetched bytes match a content reference of either length (canonical
 *  32-hex or legacy 64-hex) — the ref is always a prefix of the full sha256. */
export function verifyBlobBytes(bytes: Uint8Array, hash: string): boolean {
  return sha256Hex(bytes).slice(0, hash.length) === hash;
}

/** Store bytes content-addressed under cache/. Returns its hash + path. */
export async function putBlob(data: ArrayBuffer | Uint8Array | string): Promise<BlobInfo> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const hash = blobHash(bytes);
  const path = blobPath(hash);
  if (!(await Bun.file(path).exists())) await Bun.write(path, bytes);
  return { hash, path, size: bytes.byteLength };
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  const file = Bun.file(blobPath(hash));
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/** Store bytes under a GIVEN content hash (not recomputed) — for caching a blob
 *  fetched from a peer/bucket by its reference, which may be a legacy 64-hex hash
 *  that putBlob's truncation would not reproduce. Returns the byte length. */
export async function putBlobAt(hash: string, bytes: Uint8Array): Promise<number> {
  const path = blobPath(hash);
  if (!(await Bun.file(path).exists())) await Bun.write(path, bytes);
  return bytes.byteLength;
}

/** Remove a blob's bytes from the cache. Returns its size, or 0 if absent. */
export async function deleteBlob(hash: string): Promise<number> {
  const file = Bun.file(blobPath(hash));
  if (!(await file.exists())) return 0;
  const size = file.size;
  await file.delete();
  return size;
}
