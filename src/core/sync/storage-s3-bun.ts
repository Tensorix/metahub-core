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

// ── Bucket CORS bootstrap (Bun-only) ────────────────────────────────────────
// A browser shell can't open its own CORS: the PutBucketCors request would itself
// be a cross-origin call the bucket hasn't whitelisted yet (chicken-and-egg). So
// the desktop (which holds the bucket credentials) sets it on the phone's behalf.
// Bun.S3Client has no PutBucketCors API, so we sign a raw `?cors` request with
// aws4fetch — same signer the browser client already uses (no hand-rolled SigV4).

const MANAGED_CORS_RULE_ID = "metahub-pwa";

function corsEndpoint(config: S3Config): { aws: AwsClient; url: string } {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region || "auto",
    service: "s3",
  });
  const origin = new URL(config.endpoint).origin;
  // Bucket-level subresource: virtual-hosted has the bucket in the host already
  // (COS), path-style puts it in the path (R2/MinIO/S3).
  const base = isVirtualHostedStyle(config) ? origin : `${origin}/${config.bucket}`;
  return { aws, url: `${base}/?cors` };
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
