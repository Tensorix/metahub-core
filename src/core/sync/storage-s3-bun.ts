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
import type { AwsClient } from "aws4fetch";
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
  awsSigner,
  objectUrlOf,
  corsEndpoint,
  getBucketCors,
  buildCorsXml,
} from "./storage-s3-sign.ts";

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

  // aws4fetch fallback for conditional overwrites: Bun.S3Client.write has no
  // If-Match, so an ifMatch put signs a raw PUT the same way presignGet does.
  // Lazy — only the rare drop-key CAS pays for it, not every list/get/put.
  let awsLazy: AwsClient | null = null;
  const aws = () => (awsLazy ??= awsSigner(config));
  const objectUrl = (key: string) => objectUrlOf(config, key);

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
      // Conditional overwrite (CAS): route through aws4fetch since Bun.S3Client
      // has no If-Match — a real atomic compare-and-set (unlike the ifNoneMatch
      // pre-check above), so concurrent drop-key rotations converge instead of
      // clobbering.
      if (opts?.ifMatch) {
        const res = await aws().fetch(objectUrl(key), {
          method: "PUT",
          body,
          headers: {
            "if-match": opts.ifMatch,
            ...(opts.contentType ? { "content-type": opts.contentType } : {}),
          },
        });
        if (res.status === 412) throw new MhError("conflict", `S3 If-Match failed: ${key}`);
        if (!res.ok) throw new MhError("network", `S3 put failed: ${res.status} ${key}`);
        return;
      }
      await s3.file(key).write(body, opts?.contentType ? { type: opts.contentType } : undefined);
    },

    async del(key: string): Promise<void> {
      await s3.file(key).delete();
    },
  };
}

setStorageClientFactory(makeClient);

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
