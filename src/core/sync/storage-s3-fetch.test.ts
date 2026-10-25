import { expect, test } from "bun:test";
import { createFetchStorageClient } from "./storage-s3-fetch.ts";
import { getBucketBlob, putBucketBlob, setStorageClientFactory, type S3Config, type StorageClient } from "./storage.ts";
import { generateMasterKey, toB64 } from "./e2ee.ts";

const config: S3Config = {
  endpoint: "https://bucket.example", bucket: "bucket", region: "auto", prefix: "mh",
  accessKeyId: "access", secretAccessKey: "secret", encrypt: true,
};

test("shared S3 client signs paginated list and preserves conditional puts", async () => {
  const requests: Request[] = [];
  const transport = (async (input: RequestInfo | URL) => {
    const req = input as Request;
    requests.push(req);
    expect(req.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
    if (req.method === "PUT") return new Response(null, { status: 412 });
    return new Response(requests.length === 1
      ? "<ListBucketResult><Contents><Key>mh/a&amp;b</Key><ETag>v1</ETag></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken></ListBucketResult>"
      : "<ListBucketResult><CommonPrefixes><Prefix>mh/folder/</Prefix></CommonPrefixes><IsTruncated>false</IsTruncated></ListBucketResult>");
  }) as typeof fetch;
  const client = createFetchStorageClient(config, { fetch: transport });
  expect(await client.list("mh/", "mh/a", "/")).toEqual([
    { key: "mh/a&b", etag: "v1" }, { key: "mh/folder/" },
  ]);
  expect(new URL(requests[1]!.url).searchParams.get("continuation-token")).toBe("a&b");
  await expect(client.put("a b/file", new Uint8Array([1]), { ifMatch: "v1", contentType: "text/plain" })).rejects.toMatchObject({ code: "conflict" });
  expect(requests[2]!.headers.get("if-match")).toBe("v1");
  expect(requests[2]!.headers.get("content-type")).toBe("text/plain");
  expect(requests[2]!.url).toContain("/a%20b/file");
});

test("shared S3 client bounds an unresponsive transport and honors cancellation", async () => {
  const transport = (() => new Promise(() => {})) as unknown as typeof fetch;
  const client = createFetchStorageClient(config, { fetch: transport, timeoutMs: 10 });
  await expect(client.get("object")).rejects.toThrow("timed out");
  const controller = new AbortController();
  controller.abort(new Error("disposed"));
  const cancelled = createFetchStorageClient(config, { fetch: transport, signal: controller.signal });
  await expect(cancelled.list("mh/")).rejects.toThrow("disposed");
});

test("shared S3 client does not expose response body secrets in errors", async () => {
  const client = createFetchStorageClient(config, {
    fetch: (async () => new Response("secret-credential", { status: 403 })) as typeof fetch,
  });
  await expect(client.get("object")).rejects.toThrow("S3 get failed: 403");
});

test("S3 download refuses oversized declared bodies before allocation and cancels over-limit streams", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    });
    const client = createFetchStorageClient(config, {
      fetch: (async () => new Response(body, { headers: declared ? { "content-length": "100" } : {} })) as typeof fetch,
    });
    await expect(client.get("object", { maxBytes: 6 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(cancelled).toBe(true);
  }
});

test("S3 non-streaming response fallback still enforces the attachment limit", async () => {
  const client = createFetchStorageClient(config, {
    fetch: (async () => ({
      ok: true, status: 200, headers: new Headers(),
      arrayBuffer: async () => new Uint8Array(7).buffer,
    })) as unknown as typeof fetch,
  });
  await expect(client.get("object", { maxBytes: 6 })).rejects.toMatchObject({ code: "invalid_input" });
});

test("S3 abort cancels a stalled streamed attachment reader", async () => {
  const abort = new AbortController();
  let cancelled = false, requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { requested(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const client = createFetchStorageClient(config, { signal: abort.signal, fetch: (async () => new Response(body)) as typeof fetch });
  const pending = client.get("object", { maxBytes: 6 });
  await started;
  // Let signing and reader setup finish before aborting the pending read.
  await new Promise(resolve => setTimeout(resolve, 0));
  abort.abort(new Error("workspace disposed"));
  await expect(pending).rejects.toThrow("workspace disposed");
  expect(cancelled).toBe(true);
});

test("encrypted blob limits account for wire overhead and cancelled transfers never return late bytes", async () => {
  const objects = new Map<string, Uint8Array>();
  const encrypted = { ...config, masterKey: toB64(generateMasterKey()) };
  let maxBytes: number | undefined, ownedSignal: AbortSignal | undefined;
  const storage: StorageClient = {
    async list() { return []; }, async del() {},
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key, options) { maxBytes = options?.maxBytes; return objects.get(key) ?? null; },
  };
  setStorageClientFactory((_config, options) => { ownedSignal = options?.signal; return storage; });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await expect(putBucketBlob(encrypted, "hash", bytes, { maxBytes: 4 })).rejects.toMatchObject({ code: "invalid_input" });
  expect(objects.size).toBe(0);
  await putBucketBlob(encrypted, "hash", bytes, { maxBytes: 5 });
  expect([...objects.values()][0]!.byteLength).toBe(33);
  expect(await getBucketBlob(encrypted, "hash", { maxBytes: 5 })).toEqual(bytes);
  expect(maxBytes).toBe(33);
  await expect(getBucketBlob(encrypted, "hash", { maxBytes: 4 })).rejects.toMatchObject({ code: "invalid_input" });
  let release!: (bytes: Uint8Array) => void;
  storage.get = () => new Promise(resolve => { release = resolve; });
  const abort = new AbortController();
  const pending = getBucketBlob(encrypted, "hash", { signal: abort.signal, maxBytes: 5 });
  abort.abort(new Error("session ended"));
  await expect(pending).rejects.toThrow("session ended");
  expect(ownedSignal?.aborted).toBe(true);
  release([...objects.values()][0]!);
  await Promise.resolve();
});
