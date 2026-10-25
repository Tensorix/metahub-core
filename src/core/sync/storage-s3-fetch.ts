// Shared fetch/SigV4 S3 adapter for browsers and native replicas.
import { withSyncBudget } from "./transport.ts";

export interface FetchStorageClientOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

import { MhError } from "../errors.ts";
import {
  type StorageClient,
  type StorageObject,
  type StoragePutOpts,
  type S3Config,
} from "./storage.ts";
// Signer + addressing come from the shared runtime-neutral module, so a fix
// there can't land on one runtime and 403 the other.
import { awsSigner, bucketBase, objectUrlOf } from "./storage-s3-sign.ts";

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function createFetchStorageClient(config: S3Config, opts: FetchStorageClientOpts = {}): StorageClient {
  const aws = awsSigner(config);
  // Bound signing, fetch and body decoding as one operation. Keep aws4fetch's
  // retry behavior by default; an injected transport owns its own retry policy.
  async function request<T>(url: string, init: RequestInit, read: (res: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    return withSyncBudget(async (signal) => {
      const res = opts.fetch
        ? await opts.fetch(await aws.sign(url, { ...init, signal }))
        : await aws.fetch(url, { ...init, signal });
      return read(res, signal);
    }, opts.timeoutMs, opts.signal);
  }
  // Path-style is `<host>/<bucket>/<key>`; virtual-hosted (COS) is `<host>/<key>`
  // with the bucket already in the host. The base for bucket-level ops (list)
  // follows the same split.
  const base = bucketBase(config);
  const objectUrl = (key: string) => objectUrlOf(config, key);

  async function fail(res: Response, what: string): Promise<never> {
    throw new MhError(res.status === 401 || res.status === 403 ? "auth" : "network", `S3 ${what} failed: ${res.status}`);
  }

  return {
    async list(prefix: string, startAfter?: string, delimiter?: string): Promise<StorageObject[]> {
      const out: StorageObject[] = [];
      let continuationToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const u = new URL(base);
        u.searchParams.set("list-type", "2");
        u.searchParams.set("prefix", prefix);
        u.searchParams.set("max-keys", "1000");
        if (startAfter) u.searchParams.set("start-after", startAfter);
        if (delimiter) u.searchParams.set("delimiter", delimiter);
        if (continuationToken) u.searchParams.set("continuation-token", continuationToken);
        const xml = await request(u.toString(), { method: "GET" }, async (res) => {
          if (!res.ok) await fail(res, "list");
          return res.text();
        });
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
        if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
          const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
          if (!next || seenTokens.has(next)) throw new Error("S3 list returned an invalid continuation token");
          seenTokens.add(next);
          continuationToken = decodeXmlEntities(next);
        } else continuationToken = undefined;
      } while (continuationToken);
      return out;
    },

    async get(key: string, options?: { maxBytes?: number }): Promise<Uint8Array | null> {
      return request(objectUrl(key), {}, async (res, signal) => {
        if (res.status === 404) return null;
        if (!res.ok) await fail(res, "get");
        const maxBytes = options?.maxBytes;
        if (maxBytes == null) return new Uint8Array(await res.arrayBuffer());
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a nonnegative safe integer");
        const tooLarge = () => new MhError("invalid_input", "Attachment exceeds the size limit");
        const length = res.headers.get("content-length");
        if (length != null && Number(length) > maxBytes) {
          void res.body?.cancel().catch(() => {});
          throw tooLarge();
        }
        // React Native may omit response streams. Check declared length first
        // there, then enforce the cap immediately after its arrayBuffer fallback.
        const reader = res.body?.getReader?.();
        if (!reader) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.byteLength > maxBytes) throw tooLarge();
          return bytes;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            if (signal.aborted) throw signal.reason ?? new Error("blob transfer aborted");
            const chunk = await reader.read();
            if (signal.aborted) throw signal.reason ?? new Error("blob transfer aborted");
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maxBytes) { cancel(); throw tooLarge(); }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return bytes;
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      });
    },

    async put(key: string, body: Uint8Array, opts?: StoragePutOpts): Promise<void> {
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      // Conditional create: S3/R2 reject with 412 if the object already exists.
      if (opts?.ifNoneMatch) headers["if-none-match"] = "*";
      // Conditional overwrite (CAS): 412 if the current ETag differs.
      if (opts?.ifMatch) headers["if-match"] = opts.ifMatch;
      await request(objectUrl(key), {
        method: "PUT",
        body: body as unknown as BodyInit,
        headers: Object.keys(headers).length ? headers : undefined,
      }, async (res) => {
      if ((opts?.ifNoneMatch || opts?.ifMatch) && res.status === 412) {
        throw new MhError("conflict", `S3 conditional put failed (${opts?.ifMatch ? "If-Match" : "exists"}): ${key}`);
      }
      if (!res.ok) await fail(res, "put");
      });
    },

    async del(key: string): Promise<void> {
      await request(objectUrl(key), { method: "DELETE" }, async (res) => {
        if (!res.ok && res.status !== 404) await fail(res, "delete");
      });
    },
  };
}
