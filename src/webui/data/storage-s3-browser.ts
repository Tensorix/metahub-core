// Browser implementation of the storage-sync StorageClient: AWS Signature V4
// signed against an S3-compatible endpoint with WebCrypto + fetch — no SDK, no
// dependency. Importing this module (from the db-worker) registers the factory,
// so an 's3' peer the worker syncs resolves to this client. The Bun nodes use
// Bun.S3Client instead (core/sync/storage-s3-bun.ts).
//
// Path-style addressing (https://<endpoint>/<bucket>/<key>) works for R2,
// MinIO, and S3 alike. The bucket must allow CORS for the PWA origin (GET/PUT/
// HEAD/DELETE) — that's the one setup step that lets a phone talk to the bucket
// directly; the settings page surfaces a clear message when it's missing.

import {
  setStorageClientFactory,
  type StorageClient,
  type StorageObject,
  type S3Config,
} from "../../core/sync/storage.ts";

const enc = new TextEncoder();

// bun-types/DOM widen Uint8Array to <ArrayBufferLike>; WebCrypto wants an
// ArrayBuffer-backed BufferSource. Our arrays are always ArrayBuffer-backed.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function sha256hex(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bs(data))));
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(enc.encode(msg))));
}

/** RFC-3986 percent-encoding as AWS SigV4 expects (encodeURIComponent leaves a
 *  few sub-delims; encode those too). `keepSlash` preserves path separators. */
function uriEncode(s: string, keepSlash = false): string {
  let out = encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  if (keepSlash) out = out.replace(/%2F/g, "/");
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

interface SignedRequest {
  query?: Record<string, string>;
  body?: Uint8Array;
  contentType?: string;
}

function makeClient(config: S3Config): StorageClient {
  const origin = new URL(config.endpoint).origin;
  const host = new URL(config.endpoint).host;
  const region = config.region || "auto";
  const service = "s3";

  /** Sign and send one request. `resource` is bucket or bucket/key (no leading slash). */
  async function send(method: string, resource: string, opts: SignedRequest = {}): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20260613T151920Z
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;

    const canonicalUri = "/" + uriEncode(resource, true);
    const query = opts.query ?? {};
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
      .join("&");

    const payloadHash = await sha256hex(opts.body ?? new Uint8Array(0));
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await sha256hex(enc.encode(canonicalRequest)),
    ].join("\n");

    const kDate = await hmac(enc.encode("AWS4" + config.secretAccessKey), dateStamp);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, "aws4_request");
    const signature = hex(await hmac(kSigning, stringToSign));

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
      authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };
    if (opts.contentType) headers["content-type"] = opts.contentType;

    const url = `${origin}${canonicalUri}${canonicalQuery ? "?" + canonicalQuery : ""}`;
    return fetch(url, {
      method,
      headers,
      body: opts.body ? bs(opts.body) : undefined,
    });
  }

  async function fail(res: Response, what: string): Promise<never> {
    const detail = await res.text().catch(() => "");
    throw new Error(`S3 ${what} failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  return {
    async list(prefix: string, startAfter?: string): Promise<StorageObject[]> {
      const out: StorageObject[] = [];
      let continuationToken: string | undefined;
      do {
        const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
        if (startAfter) query["start-after"] = startAfter;
        if (continuationToken) query["continuation-token"] = continuationToken;
        const res = await send("GET", config.bucket, { query });
        if (!res.ok) await fail(res, "list");
        const xml = await res.text();
        const re = /<Contents>([\s\S]*?)<\/Contents>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml))) {
          const block = m[1]!;
          const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
          if (!key) continue;
          out.push({ key: decodeXmlEntities(key), etag: /<ETag>([^<]*)<\/ETag>/.exec(block)?.[1] });
        }
        continuationToken = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
          : undefined;
      } while (continuationToken);
      return out;
    },

    async get(key: string): Promise<Uint8Array | null> {
      const res = await send("GET", `${config.bucket}/${key}`);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "get");
      return new Uint8Array(await res.arrayBuffer());
    },

    async put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
      const res = await send("PUT", `${config.bucket}/${key}`, { body, contentType });
      if (!res.ok) await fail(res, "put");
    },

    async del(key: string): Promise<void> {
      const res = await send("DELETE", `${config.bucket}/${key}`);
      if (!res.ok && res.status !== 404) await fail(res, "delete");
    },
  };
}

setStorageClientFactory(makeClient);
