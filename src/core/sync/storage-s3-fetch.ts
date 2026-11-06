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
import { awsSigner, bucketBase, objectUrlOf, conditionalWriteProvider } from "./storage-s3-sign.ts";

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
      // React Native's Request adds a cache-busting query for these modes.
      // Finalize that query before signing, and don't let Request mutate it again.
      if (init.cache === "no-store" || init.cache === "no-cache") {
        const fresh = new URL(url);
        fresh.searchParams.set("__mh_refresh", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        url = fresh.toString();
        const { cache: _cache, ...rest } = init;
        init = rest;
      }
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

  // COS ignores standard PUT preconditions. Its native forbid-overwrite
  // header is safe only before versioning has ever been enabled. Recheck on
  // every conditional create: a long-lived client must not cache this state.
  async function requireCosConditionalCreate(): Promise<void> {
    await request(`${base}/?versioning`, { method: "GET" }, async (res) => {
      if (!res.ok) {
        await fail(res, "versioning check", "Tencent COS conditional creation requires cos:GetBucketVersioning permission; ");
      }
      const xml = await res.text();
      // The documented never-enabled response has an empty root (optionally
      // with an XML declaration and namespace). Unknown XML must fail closed.
      const neverEnabled = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<VersioningConfiguration(?:\s+[^>]*?)?\s*(?:\/>|>\s*<\/VersioningConfiguration>)\s*$/.test(xml);
      if (!neverEnabled) {
        throw new MhError("invalid_input", "Tencent COS conditional creation requires a bucket that has never enabled versioning; enabled, suspended or unverified versioning cannot prevent overwrites");
      }
    });
  }

  async function fail(res: Response, what: string, context = ""): Promise<never> {
    const prefix = `${context}S3 ${what} failed: ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      const code = body.match(/<Code>\s*([A-Za-z0-9]+)\s*<\/Code>/)?.[1];
      // Only fixed explanations and known codes may escape this layer; error
      // bodies can contain credentials, signatures and canonical requests.
      if (code === "SignatureDoesNotMatch")
        throw new MhError("network", `${prefix}：请求签名校验失败，请检查签名与请求 URL 是否一致 (SignatureDoesNotMatch)`);
      if (code === "AccessDenied" || code === "AllAccessDisabled" || code === "UnauthorizedOperation")
        throw new MhError("invalid_input", `${prefix}：存储桶权限不足，请检查访问策略 (${code})`);
      if (code === "RequestTimeTooSkewed" || code === "RequestExpired")
        throw new MhError("clock_skew", `${prefix}：请求时间无效，请检查设备时钟 (${code})`);
      if (["InvalidAccessKeyId", "InvalidSecurity", "ExpiredToken", "InvalidToken", "TokenRefreshRequired", "InvalidClientTokenId"].includes(code ?? ""))
        throw new MhError("auth", `${prefix}：连接凭据无效或已过期，请更新凭据 (${code})`);
    }
    throw new MhError(res.status === 401 ? "auth" : "network", prefix);
  }

  return {
    async conditionalCreateCapability() {
      const provider = conditionalWriteProvider(config);
      if (provider === "cos") { await requireCosConditionalCreate(); return true; }
      // S3-compatible does not itself promise atomic create semantics.
      const host = new URL(config.endpoint).hostname;
      return /(?:^|\.)amazonaws\.com(?:\.cn)?$|(?:^|\.)r2\.cloudflarestorage\.com$/i.test(host);
    },
    async getWithMetadata(key, options) {
      const maxBytes = options.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new RangeError("maxBytes must be a nonnegative safe integer");
      // Time verification needs a current storage response, including current
      // CORS headers. A page reload need not invalidate cached object responses.
      return request(objectUrl(key), { cache: "no-store" }, async (res, signal) => {
        if (res.status === 404) return null;
        if (!res.ok) await fail(res, "get");
        const length = res.headers.get("content-length");
        const tooLarge = () => new MhError("invalid_input", "Storage object exceeds the size limit");
        if (length !== null && Number(length) > maxBytes) {
          await res.body?.cancel();
          throw tooLarge();
        }
        const reader = res.body?.getReader?.();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            while (true) {
              if (signal.aborted) throw signal.reason;
              const chunk = await reader.read();
              if (signal.aborted) throw signal.reason;
              if (chunk.done) break;
              total += chunk.value.length;
              if (total > maxBytes) { await reader.cancel(); throw tooLarge(); }
              chunks.push(chunk.value);
            }
          } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
        } else {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length > maxBytes) throw tooLarge();
          chunks.push(bytes); total = bytes.length;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const date = (name: string) => {
          const raw = res.headers.get(name), value = raw === null ? NaN : Date.parse(raw);
          return Number.isFinite(value) ? value : null;
        };
        return { bytes, serverDate: date("date"), lastModified: date("last-modified"), etag: res.headers.get("etag") };
      });
    },
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
      const conditional = !!opts?.ifNoneMatch || opts?.ifMatch !== undefined;
      if (opts?.ifMatch !== undefined && (!opts.ifMatch.trim() || opts.ifNoneMatch))
        throw new MhError("invalid_input", "Conditional put requires one nonempty If-Match value or If-None-Match");
      const provider = conditional ? conditionalWriteProvider(config) : "s3";
      // COS accepts and ignores If-Match on PUT. Never send an overwrite that
      // claims to be atomic when the backend cannot enforce its precondition.
      if (provider === "cos" && opts?.ifMatch !== undefined)
        throw new MhError("invalid_input", "Tencent COS does not support atomic conditional updates (If-Match); use storage with atomic conditional writes for key rotation or passphrase changes");
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      if (opts?.ifNoneMatch) {
        if (provider === "cos") {
          await requireCosConditionalCreate();
          headers["x-cos-forbid-overwrite"] = "true";
        } else headers["if-none-match"] = "*";
      }
      if (opts?.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
      await request(objectUrl(key), {
        method: "PUT",
        body: body as unknown as RequestInit["body"],
        headers: Object.keys(headers).length ? headers : undefined,
      }, async (res) => {
        if (conditional && res.status === 412)
          throw new MhError("conflict", "S3 conditional put precondition failed");
        if (provider === "cos" && opts?.ifNoneMatch && res.status === 409) {
          // Other COS 409s include upload/quota/object-lock failures. Only the
          // documented existing-object code means another creator won.
          const xml = await res.text();
          if (/<Code>\s*FileAlreadyExists\s*<\/Code>/.test(xml))
            throw new MhError("conflict", "Tencent COS object already exists");
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
