// Bun runtime implementation of the storage-sync StorageClient, backed by the
// built-in Bun.S3Client (zero dependencies). Importing this module registers
// the factory; CLI and server entry points import it for its side effect so any
// 's3' peer they sync resolves to a real client. The browser worker registers
// its own SigV4 client instead (webui/data/storage-s3-browser.ts) and never
// imports this Bun-only module, keeping `bun` out of the browser bundle.
//
// Request signing and the CORS document itself are runtime-neutral and live in
// storage-s3-sign.ts — importable from the browser too. Only what genuinely
// needs Bun stays here: Bun.S3Client, and PutBucketCors (Content-MD5 needs an
// MD5 that WebCrypto does not provide; a browser could not make this
// cross-origin call before its own CORS exists anyway).

import { S3Client } from "bun";
import { createFetchStorageClient } from "./storage-s3-fetch.ts";
import { MhError } from "../errors.ts";
import {
  setStorageClientFactory,
  setBucketCorsAdmin,
  isVirtualHostedStyle,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "./storage.ts";
import {
  corsEndpoint,
  getBucketCors,
  buildCorsXml,
} from "./storage-s3-sign.ts";

export function createBunStorageClient(config: S3Config): StorageClient {
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

  // Both conditional modes share the fetch adapter's provider checks and
  // atomic wire requests; a HEAD followed by an unconditional PUT can race.
  let conditionalClient: StorageClient | undefined;

  return {
    async conditionalCreateCapability() {
      conditionalClient ??= createFetchStorageClient(config);
      return conditionalClient.conditionalCreateCapability!();
    },
    async getWithMetadata(key, options) {
      conditionalClient ??= createFetchStorageClient(config);
      return conditionalClient.getWithMetadata!(key, options);
    },
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
      if (opts?.ifNoneMatch || opts?.ifMatch !== undefined) {
        conditionalClient ??= createFetchStorageClient(config);
        return conditionalClient.put(key, body, opts);
      }
      await s3.file(key).write(body, opts?.contentType ? { type: opts.contentType } : undefined);
    },

    async del(key: string): Promise<void> {
      await s3.file(key).delete();
    },
  };
}

// Preserve the factory export used by dev callers and isolated adapter tests.
export const makeBunStorageClient = createBunStorageClient;

setStorageClientFactory(createBunStorageClient);

/**
 * Allow a browser shell served from `origins` to talk to the bucket directly
 * (GET/PUT/HEAD/DELETE) via GET-merge-PUT (see buildCorsXml). `opts.merge` unions
 * with existing managed origins instead of replacing them — used when a second
 * origin attaches the same bucket. Content-MD5 is required by the CORS API
 * (S3 and COS both) — the reason this one operation is Bun-only.
 */
export async function putBucketCors(
  config: S3Config,
  origins: string[],
  opts: { merge?: boolean } = {},
): Promise<void> {
  const clean = origins.map((o) => o.trim()).filter(Boolean);
  if (clean.length === 0) throw new MhError("invalid_input", "putBucketCors: no origins given");
  const { aws, url } = corsEndpoint(config);

  const existing = await getBucketCors(config).catch(() => null);
  const xml = buildCorsXml(existing, clean, opts.merge ?? false);
  const body = new TextEncoder().encode(xml);
  const contentMd5 = new Bun.CryptoHasher("md5").update(body).digest("base64");

  const res = await aws.fetch(url, {
    method: "PUT",
    body: new Uint8Array(body).buffer,
    headers: { "content-type": "application/xml", "content-md5": contentMd5 },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`S3 put-cors failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

// Lets runtime-neutral callers (share-export.ts, reachable from the browser too)
// reach PutBucketCors without importing this Bun-only module.
setBucketCorsAdmin(putBucketCors);
