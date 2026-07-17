// Bun runtime implementation of the storage-sync StorageClient, backed by the
// built-in Bun.S3Client (zero dependencies). Importing this module registers
// the factory; CLI and server entry points import it for its side effect so any
// 's3' peer they sync resolves to a real client. The browser worker registers
// its own SigV4 client instead (webui/data/storage-s3-browser.ts) and never
// imports this Bun-only module, keeping `bun` out of the browser bundle.

import { S3Client } from "bun";
import { AwsClient } from "aws4fetch";
import { MhError } from "../errors.ts";
import {
  setStorageClientFactory,
  isVirtualHostedStyle,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "./storage.ts";

/** THE aws4fetch signer for this config — one construction shared by the CAS
 *  put, the CORS bootstrap and presignGet, so a signer-config fix can't land in
 *  one call site and 403 the others. */
function awsSigner(config: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region || "auto",
    service: "s3",
  });
}

/** Bucket-level base URL: virtual-hosted has the bucket in the host already
 *  (COS), path-style puts it in the path (R2/MinIO/S3). */
function bucketBase(config: S3Config): string {
  const origin = new URL(config.endpoint).origin;
  return isVirtualHostedStyle(config) ? origin : `${origin}/${config.bucket}`;
}

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
  const objectUrl = (key: string) =>
    `${bucketBase(config)}/${key.split("/").map(encodeURIComponent).join("/")}`;

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

// ── Bucket CORS bootstrap (Bun-only) ────────────────────────────────────────
// A browser shell can't open its own CORS: the PutBucketCors request would itself
// be a cross-origin call the bucket hasn't whitelisted yet (chicken-and-egg). So
// the desktop (which holds the bucket credentials) sets it on the phone's behalf.
// Bun.S3Client has no PutBucketCors API, so we sign a raw `?cors` request with
// aws4fetch — same signer the browser client already uses (no hand-rolled SigV4).

const MANAGED_CORS_RULE_ID = "metahub-pwa";

function corsEndpoint(config: S3Config): { aws: AwsClient; url: string } {
  return { aws: awsSigner(config), url: `${bucketBase(config)}/?cors` };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&"); // ampersand last, so it can't re-trigger the others
}

function managedCorsRule(origins: string[]): string {
  const o = origins.map((x) => `<AllowedOrigin>${escapeXml(x)}</AllowedOrigin>`).join("");
  return (
    `<CORSRule><ID>${MANAGED_CORS_RULE_ID}</ID>${o}` +
    `<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>` +
    `<AllowedMethod>HEAD</AllowedMethod><AllowedMethod>DELETE</AllowedMethod>` +
    `<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader>` +
    `<MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>`
  );
}

/** SigV4 presigned GET cap: 7 days (604800s) is the protocol maximum. */
export const MAX_PRESIGN_SECONDS = 604800;

/**
 * Build a presigned GET URL for one object (used by the object-storage share
 * path — the recipient fetches the ciphertext directly from the bucket, no
 * credential in the link). Addressing mirrors corsEndpoint (virtual-hosted vs
 * path-style). `expiresSec` is clamped to the 7-day SigV4 maximum.
 */
export async function presignGet(config: S3Config, key: string, expiresSec: number): Promise<string> {
  const aws = awsSigner(config);
  const u = new URL(`${bucketBase(config)}/${key.split("/").map(encodeURIComponent).join("/")}`);
  u.searchParams.set("X-Amz-Expires", String(Math.min(Math.max(1, Math.floor(expiresSec)), MAX_PRESIGN_SECONDS)));
  const signed = await aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

/** Read the bucket's current CORS config (raw XML), or null if none is set. */
export async function getBucketCors(config: S3Config): Promise<string | null> {
  const { aws, url } = corsEndpoint(config);
  const res = await aws.fetch(url, { method: "GET" });
  if (res.status === 404) return null; // NoSuchCORSConfiguration
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`S3 get-cors failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return await res.text();
}

/**
 * Build the PutBucketCors XML body from the bucket's current config. PutBucketCors
 * replaces the whole config, so we keep every rule that isn't ours and re-emit our
 * managed rule (id=metahub-pwa). `merge` decides our rule's origins:
 *  - false (CLI `peer cors`): SET — exactly `origins` (lets the user shrink/reset).
 *  - true  (auto-open on bucket-attach): UNION with the managed rule's existing
 *    origins, so attaching the same bucket from a second shell/origin (a homelab
 *    server origin alongside the official PWA shell) adds to the allow-list
 *    instead of clobbering it.
 * A wildcard `*` collapses the set. Pure (no I/O) so it's unit-testable.
 */
export function buildCorsXml(existing: string | null, origins: string[], merge: boolean): string {
  const kept: string[] = [];
  const prev: string[] = [];
  if (existing) {
    for (const rule of existing.match(/<CORSRule>[\s\S]*?<\/CORSRule>/g) ?? []) {
      if (rule.includes(`<ID>${MANAGED_CORS_RULE_ID}</ID>`)) {
        if (merge)
          for (const m of rule.matchAll(/<AllowedOrigin>([\s\S]*?)<\/AllowedOrigin>/g))
            prev.push(unescapeXml(m[1]!.trim()));
      } else {
        kept.push(rule);
      }
    }
  }
  const merged = [...new Set([...prev, ...origins])];
  const finalOrigins = merged.includes("*") ? ["*"] : merged;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CORSConfiguration>${kept.join("")}${managedCorsRule(finalOrigins)}</CORSConfiguration>`
  );
}

/**
 * Allow a browser shell served from `origins` to talk to the bucket directly
 * (GET/PUT/HEAD/DELETE) via GET-merge-PUT (see buildCorsXml). `opts.merge` unions
 * with existing managed origins instead of replacing them — used when a second
 * origin attaches the same bucket. Content-MD5 is required by the CORS API
 * (S3 and COS both).
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
