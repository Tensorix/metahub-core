// Bun runtime implementation of the storage-sync StorageClient, backed by the
// built-in Bun.S3Client (zero dependencies). Importing this module registers
// the factory; CLI and server entry points import it for its side effect so any
// 's3' peer they sync resolves to a real client. The browser worker registers
// its own SigV4 client instead (webui/data/storage-s3-browser.ts) and never
// imports this Bun-only module, keeping `bun` out of the browser bundle.

import { S3Client } from "bun";
import { MhError } from "../errors.ts";
import {
  setStorageClientFactory,
  isVirtualHostedStyle,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "./storage.ts";

function makeClient(config: S3Config): StorageClient {
  // Virtual-hosted (e.g. Tencent COS, which rejects path-style): the endpoint
  // host already carries the bucket, so Bun ignores the `bucket` option.
  const vhost = isVirtualHostedStyle(config);
  const s3 = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region || "auto", // R2 uses "auto"
    endpoint: config.endpoint,
    bucket: config.bucket,
    ...(vhost ? { virtualHostedStyle: true } : {}),
  });

  return {
    async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
      const out: StorageObject[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await s3.list({ prefix, startAfter, maxKeys: 1000, continuationToken, delimiter });
        for (const c of res.contents ?? []) out.push({ key: c.key, etag: c.eTag });
        // With delimiter, child "folders" come back as common prefixes (their
        // keys end in the delimiter); nodesFromKeys treats them like full keys.
        for (const p of res.commonPrefixes ?? []) out.push({ key: p.prefix });
        continuationToken = res.isTruncated ? res.nextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    },

    async get(key: string): Promise<Uint8Array | null> {
      const f = s3.file(key);
      try {
        return new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        // Single GET on the happy path; only an error pays for the existence
        // probe that tells "absent" (→ null) apart from a real failure (rethrow).
        if (await f.exists().catch(() => true)) throw e;
        return null;
      }
    },

    async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
      // Bun.S3Client.write has no native If-None-Match. Approximate the conditional
      // create with an existence pre-check: this catches the realistic ordering
      // (one device's create already visible — S3/R2 are read-after-write
      // consistent for new objects) and lets provisionMasterKey adopt the winner.
      // A truly simultaneous Bun-vs-Bun first-init on an empty bucket can still
      // race (no atomic CAS here); the browser client uses real If-None-Match.
      if (opts?.ifNoneMatch && (await s3.file(key).exists())) {
        throw new MhError("conflict", `S3 object already exists: ${key}`);
      }
      await s3.file(key).write(body, opts?.contentType ? { type: opts.contentType } : undefined);
    },

    async del(key: string): Promise<void> {
      await s3.file(key).delete();
    },
  };
}

setStorageClientFactory(makeClient);
