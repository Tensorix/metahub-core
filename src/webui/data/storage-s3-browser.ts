// Browser implementation of the storage-sync StorageClient. Request signing is
// delegated to aws4fetch (AWS Signature V4 over WebCrypto + fetch; zero
// transitive deps, ~2.6 KB gzip, built for browsers/Workers/edge) — it owns the
// fiddly, easy-to-get-subtly-wrong part (URI/query canonicalization, signed
// headers, S3's single-encode + UNSIGNED-PAYLOAD quirks). We keep only the thin
// S3 wire wrapper: list/get/put/del plus parsing the ListObjectsV2 XML, which
// aws4fetch doesn't do. Importing this module registers the factory; the
// db-worker imports it for that side effect. Bun nodes use Bun.S3Client instead.
//
// Path-style addressing (https://<endpoint>/<bucket>/<key>) works for R2,
// MinIO, and S3. The bucket must allow CORS for the PWA origin (GET/PUT/HEAD/
// DELETE) — the one setup step that lets a phone talk to the bucket directly;
// the settings page surfaces a clear message when it's missing.

import { AwsClient } from "aws4fetch";
import { MhError } from "../../core/errors.ts";
import {
  setStorageClientFactory,
  isVirtualHostedStyle,
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "../../core/sync/storage.ts";

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function makeClient(config: S3Config): StorageClient {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region || "auto", // R2 uses "auto"
    service: "s3",
  });
  const origin = new URL(config.endpoint).origin;
  // Path-style is `<host>/<bucket>/<key>`; virtual-hosted (COS) is `<host>/<key>`
  // with the bucket already in the host. The base for bucket-level ops (list)
  // follows the same split.
  const vhost = isVirtualHostedStyle(config);
  const bucketBase = vhost ? origin : `${origin}/${config.bucket}`;
  // Encode each key segment but keep the slashes; aws4fetch decodes then
  // canonically re-encodes for the signature, so a valid URL round-trips.
  const objectUrl = (key: string) =>
    `${bucketBase}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function fail(res: Response, what: string): Promise<never> {
    const detail = await res.text().catch(() => "");
    throw new Error(`S3 ${what} failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  return {
    async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
      const out: StorageObject[] = [];
      let continuationToken: string | undefined;
      do {
        const u = new URL(bucketBase);
        u.searchParams.set("list-type", "2");
        u.searchParams.set("prefix", prefix);
        u.searchParams.set("max-keys", "1000");
        if (startAfter) u.searchParams.set("start-after", startAfter);
        if (delimiter) u.searchParams.set("delimiter", delimiter);
        if (continuationToken) u.searchParams.set("continuation-token", continuationToken);
        const res = await aws.fetch(u.toString(), { method: "GET" });
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
        // With a delimiter, child "folders" come back here, not in <Contents>.
        if (delimiter) {
          const reCp = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
          while ((m = reCp.exec(xml))) {
            const p = /<Prefix>([^<]+)<\/Prefix>/.exec(m[1]!)?.[1];
            if (p) out.push({ key: decodeXmlEntities(p) });
          }
        }
        continuationToken = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
          : undefined;
      } while (continuationToken);
      return out;
    },

    async get(key: string): Promise<Uint8Array | null> {
      const res = await aws.fetch(objectUrl(key));
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "get");
      return new Uint8Array(await res.arrayBuffer());
    },

    async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      // Conditional create: S3/R2 reject with 412 if the object already exists.
      if (opts?.ifNoneMatch) headers["if-none-match"] = "*";
      // Conditional overwrite (CAS): 412 if the current ETag differs.
      if (opts?.ifMatch) headers["if-match"] = opts.ifMatch;
      const res = await aws.fetch(objectUrl(key), {
        method: "PUT",
        body: body as unknown as BodyInit,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      if ((opts?.ifNoneMatch || opts?.ifMatch) && res.status === 412) {
        throw new MhError("conflict", `S3 conditional put failed (${opts?.ifMatch ? "If-Match" : "exists"}): ${key}`);
      }
      if (!res.ok) await fail(res, "put");
    },

    async del(key: string): Promise<void> {
      const res = await aws.fetch(objectUrl(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) await fail(res, "delete");
    },
  };
}

setStorageClientFactory(makeClient);
