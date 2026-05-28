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

/** Store bytes content-addressed (sha256) under cache/. Returns its hash + path. */
export async function putBlob(data: ArrayBuffer | Uint8Array | string): Promise<BlobInfo> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const hash = hasher.digest("hex");
  const path = blobPath(hash);
  if (!(await Bun.file(path).exists())) await Bun.write(path, bytes);
  return { hash, path, size: bytes.byteLength };
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  const file = Bun.file(blobPath(hash));
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}
