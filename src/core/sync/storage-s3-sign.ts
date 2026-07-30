// Runtime-agnostic S3 request signing + bucket-CORS document handling: no `bun`
// / `node:` imports and no Bun globals, so EVERY runtime shares one copy — the
// Bun client (storage-s3-bun.ts), the browser worker's SigV4 client
// (webui/data/storage-s3-browser.ts), and the share export path
// (share-export.ts), which is reachable from BOTH the server and the browser
// replica. Signing lives here rather than next to Bun.S3Client precisely so a
// signer-config fix can't land in one runtime and 403 the other.
//
// Everything here rides on aws4fetch (SigV4 over WebCrypto + fetch) or plain
// strings. The one genuinely Bun-bound bucket operation — PutBucketCors, which
// needs a Content-MD5 that WebCrypto cannot produce — stays in
// storage-s3-bun.ts and is reached through the storage.ts registry.

import { AwsClient } from "aws4fetch";
import { isVirtualHostedStyle, type S3Config } from "./storage.ts";

/** THE aws4fetch signer for this config — one construction shared by the CAS
 *  put, the CORS bootstrap and presignGet, so a signer-config fix can't land in
 *  one call site and 403 the others. */
export function awsSigner(config: S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region || "auto",
    service: "s3",
  });
}

/** Bucket-level base URL: virtual-hosted has the bucket in the host already
 *  (COS), path-style puts it in the path (R2/MinIO/S3). */
export function bucketBase(config: S3Config): string {
  const origin = new URL(config.endpoint).origin;
  return isVirtualHostedStyle(config) ? origin : `${origin}/${config.bucket}`;
}

/** Object URL for one key. Each segment is encoded but the slashes are kept;
 *  aws4fetch decodes then canonically re-encodes for the signature, so a valid
 *  URL round-trips. One definition, so the signed URL and the fetched URL can't
 *  drift apart across runtimes. */
export function objectUrlOf(config: S3Config, key: string): string {
  return `${bucketBase(config)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// ── Bucket CORS document ────────────────────────────────────────────────────
// A browser shell can't open its own CORS: the PutBucketCors request would itself
// be a cross-origin call the bucket hasn't whitelisted yet (chicken-and-egg). So
// the desktop (which holds the bucket credentials) sets it on the phone's behalf.
// Bun.S3Client has no PutBucketCors API, so we sign a raw `?cors` request with
// aws4fetch — same signer the browser client already uses (no hand-rolled SigV4).
// Reading + building the document is runtime-neutral; only the PUT (Content-MD5)
// is Bun-bound.

export const MANAGED_CORS_RULE_ID = "metahub-pwa";

export function corsEndpoint(config: S3Config): { aws: AwsClient; url: string } {
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
  const u = new URL(objectUrlOf(config, key));
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
