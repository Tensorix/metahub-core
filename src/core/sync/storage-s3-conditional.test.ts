import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../schema-init.ts";
import { generateMasterKey, toB64 } from "./e2ee.ts";
import { ensureDropKeys, getLocalDropKeyring, rotateDropKeys } from "./drop-keys.ts";
import { provisionMasterKey, rewrapMasterKey } from "./storage.ts";
import { createFetchStorageClient } from "./storage-s3-fetch.ts";
import { createBunStorageClient } from "./storage-s3-bun.ts";
import { conditionalWriteProvider } from "./storage-s3-sign.ts";
import type { S3Config } from "./storage.ts";

const cos: S3Config = {
  endpoint: "https://fixture-1250000000.cos.ap-shanghai.myqcloud.com", bucket: "fixture-1250000000", region: "ap-shanghai",
  prefix: "synthetic", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret", encrypt: false,
};
const unversioned = '<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://cos.example/"/>';
const requestOf = (input: RequestInfo | URL) => input as Request;

test("COS conditional capabilities follow official hostnames rather than addressing or a display label", () => {
  for (const host of ["fixture-1250000000.cos.ap-shanghai.myqcloud.com", "cos.ap-shanghai.myqcloud.com", "fixture-1250000000.cos.accelerate.myqcloud.com", "fixture-1250000000.cos-internal.ap-shanghai.myqcloud.com"]) {
    expect(conditionalWriteProvider({ ...cos, endpoint: `https://${host}` })).toBe("cos");
  }
  for (const host of ["cos.example", "fixture.cos.ap-shanghai.myqcloud.com.evil.example", "other.myqcloud.com"]) {
    expect(conditionalWriteProvider({ ...cos, endpoint: `https://${host}`, provider: undefined, virtualHostedStyle: true })).toBe("s3");
    expect(() => conditionalWriteProvider({ ...cos, endpoint: `https://${host}`, provider: "cos" })).toThrow("custom-domain capabilities cannot be verified");
  }
});

test("COS conditional create uses forbid-overwrite and preserves the winner on FileAlreadyExists", async () => {
  const requests: Request[] = [];
  let stored: Uint8Array | undefined;
  const client = createFetchStorageClient(cos, { fetch: (async input => {
    const request = requestOf(input); requests.push(request);
    if (request.method === "GET") {
      expect(new URL(request.url).searchParams.has("versioning")).toBe(true);
      return new Response(unversioned);
    }
    expect(request.headers.get("x-cos-forbid-overwrite")).toBe("true");
    expect(request.headers.get("if-none-match")).toBeNull();
    expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
    if (stored) return new Response("<Error><Code>FileAlreadyExists</Code></Error>", { status: 409 });
    stored = new Uint8Array(await request.arrayBuffer());
    return new Response(null);
  }) as typeof fetch });
  await client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true });
  await expect(client.put("synthetic/key", new Uint8Array([2]), { ifNoneMatch: true })).rejects.toMatchObject({ code: "conflict" });
  expect(stored).toEqual(new Uint8Array([1]));
  expect(requests.map(request => request.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
});

test("COS rechecks versioning for each conditional create instead of caching old bucket state", async () => {
  let checks = 0, writes = 0;
  const client = createFetchStorageClient(cos, { fetch: (async input => {
    if (requestOf(input).method === "GET") return new Response(++checks === 1 ? unversioned : "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
    writes++; return new Response(null);
  }) as typeof fetch });
  await client.put("synthetic/one", new Uint8Array([1]), { ifNoneMatch: true });
  await expect(client.put("synthetic/two", new Uint8Array([2]), { ifNoneMatch: true })).rejects.toThrow("never enabled versioning");
  expect(checks).toBe(2); expect(writes).toBe(1);
});

for (const state of ["Enabled", "Suspended", "unrecognized"]) {
  test(`COS ${state} versioning refuses conditional creation before any PUT`, async () => {
    let writes = 0;
    const xml = state === "unrecognized" ? "<Other/>" : `<VersioningConfiguration><Status>${state}</Status></VersioningConfiguration>`;
    const client = createFetchStorageClient(cos, { fetch: (async input => {
      if (requestOf(input).method === "PUT") writes++;
      return new Response(xml);
    }) as typeof fetch });
    await expect(client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true })).rejects.toMatchObject({ code: "invalid_input" });
    expect(writes).toBe(0);
  });
}

test("COS unavailable versioning permission fails clearly without a HEAD or PUT fallback", async () => {
  const requests: string[] = [];
  const client = createFetchStorageClient(cos, { fetch: (async input => {
    requests.push(requestOf(input).method);
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  }) as typeof fetch });
  await expect(client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("cos:GetBucketVersioning") });
  expect(requests).toEqual(["GET"]);
});

test("COS atomic conditional updates fail before network access; ordinary reads and writes remain available", async () => {
  const requests: string[] = [];
  const client = createFetchStorageClient(cos, { fetch: (async input => {
    requests.push(requestOf(input).method); return new Response(new Uint8Array([9]));
  }) as typeof fetch });
  await expect(client.put("synthetic/key", new Uint8Array([1]), { ifMatch: '"old"' })).rejects.toThrow("does not support atomic conditional updates");
  expect(requests).toEqual([]);
  expect(await client.get("synthetic/key")).toEqual(new Uint8Array([9]));
  await client.put("synthetic/key", new Uint8Array([1]));
  expect(requests).toEqual(["GET", "PUT"]);
});

test("a COS display preset with an unverified custom domain refuses conditional writes only", async () => {
  let requests = 0;
  const client = createFetchStorageClient({ ...cos, provider: "cos", endpoint: "https://custom.example", virtualHostedStyle: true }, {
    fetch: (async () => { requests++; return new Response(null); }) as unknown as typeof fetch,
  });
  await expect(client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true })).rejects.toThrow("custom-domain capabilities cannot be verified");
  expect(requests).toBe(0);
  await client.put("synthetic/key", new Uint8Array([1]));
  expect(requests).toBe(1);
});

test("COS non-existence conflicts alone are reported as conditional-create conflicts", async () => {
  for (const code of ["UploadConflict", "ObjectLocked", "QuotaConflict"]) {
    const client = createFetchStorageClient(cos, { fetch: (async input => new Response(
      requestOf(input).method === "GET" ? unversioned : `<Error><Code>${code}</Code></Error>`,
      { status: requestOf(input).method === "GET" ? 200 : 409 },
    )) as typeof fetch });
    await expect(client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true })).rejects.toMatchObject({ code: "network" });
  }
});

test("standard S3 conditional create keeps its atomic header and maps 412 without COS preflights", async () => {
  const requests: Request[] = [];
  const client = createFetchStorageClient({ ...cos, endpoint: "https://s3.example" }, { fetch: (async input => {
    const request = requestOf(input); requests.push(request); return new Response(null, { status: 412 });
  }) as typeof fetch });
  await expect(client.put("synthetic/key", new Uint8Array([1]), { ifNoneMatch: true })).rejects.toMatchObject({ code: "conflict" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get("if-none-match")).toBe("*");
  expect(requests[0]!.headers.has("x-cos-forbid-overwrite")).toBe(false);
});

test("Bun conditional puts use atomic wire preconditions, including concurrent creates, without HEAD races", async () => {
  const objects = new Map<string, Uint8Array>();
  const requests: { method: string; none: string | null; match: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const key = new URL(request.url).pathname;
    const none = request.headers.get("if-none-match"), match = request.headers.get("if-match");
    requests.push({ method: request.method, none, match });
    if (request.method !== "PUT") return new Response(null, { status: 500 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (none === "*" && objects.has(key) || match && match !== '"current"') return new Response(null, { status: 412 });
    objects.set(key, bytes);
    return new Response(null, { headers: { etag: '"current"' } });
  } });
  const config = { ...cos, endpoint: `http://127.0.0.1:${server.port}`, bucket: "fixture", provider: "s3", virtualHostedStyle: false };
  const a = createBunStorageClient(config), b = createBunStorageClient(config);
  try {
    const results = await Promise.allSettled([
      a.put("synthetic/race", new Uint8Array([1]), { ifNoneMatch: true }),
      b.put("synthetic/race", new Uint8Array([2]), { ifNoneMatch: true }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "conflict" });
    const retained = objects.get("/fixture/synthetic/race");
    expect(retained).toEqual(results[0]!.status === "fulfilled" ? new Uint8Array([1]) : new Uint8Array([2]));
    await expect(a.put("synthetic/race", new Uint8Array([3]), { ifMatch: '"stale"' })).rejects.toMatchObject({ code: "conflict" });
    expect(objects.get("/fixture/synthetic/race")).toEqual(retained);
    await a.put("synthetic/race", new Uint8Array([4]), { ifMatch: '"current"' });
    expect(objects.get("/fixture/synthetic/race")).toEqual(new Uint8Array([4]));
    expect(requests.every(request => request.method === "PUT")).toBe(true);
    expect(requests.slice(0, 2).every(request => request.none === "*")).toBe(true);
    await a.put("synthetic/ordinary", new Uint8Array([5]));
    expect(objects.get("/fixture/synthetic/ordinary")).toEqual(new Uint8Array([5]));
  } finally { await server.stop(true); }
});

test("COS key rotation and passphrase changes refuse unsupported CAS without replacing remote or cached keys", async () => {
  const objects = new Map<string, Uint8Array>();
  let writes = 0;
  const masterKey = generateMasterKey();
  const config = { ...cos, encrypt: true, masterKey: toB64(masterKey) };
  const client = createFetchStorageClient(config, { fetch: (async input => {
    const request = requestOf(input), url = new URL(request.url);
    if (url.searchParams.has("versioning")) return new Response(unversioned);
    if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => `<Contents><Key>${key}</Key><ETag>"current"</ETag></Contents>`).join("");
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const key = url.pathname.slice(1);
    if (request.method === "GET") return objects.has(key) ? new Response(new Uint8Array(objects.get(key)!).buffer) : new Response(null, { status: 404 });
    writes++;
    if (objects.has(key)) return new Response("<Error><Code>FileAlreadyExists</Code></Error>", { status: 409 });
    objects.set(key, new Uint8Array(await request.arrayBuffer())); return new Response(null);
  }) as typeof fetch });
  const db = new Database(":memory:"); runSchema(db);
  const bucket = { peerUrl: "s3://synthetic", config, base: "synthetic/spaces/default", keyPath: "synthetic/spaces/default/keys/drop.json", masterKey, client: () => client };
  try {
    await ensureDropKeys(db, { bucket });
    const cached = getLocalDropKeyring(db), remoteKey = objects.get(bucket.keyPath)!.slice();
    const beforeRotation = writes;
    await expect(rotateDropKeys(db, { bucket })).rejects.toThrow("does not support atomic conditional updates");
    expect(writes).toBe(beforeRotation);
    expect(getLocalDropKeyring(db)).toEqual(cached);
    expect(objects.get(bucket.keyPath)).toEqual(remoteKey);
    await provisionMasterKey(client, config, "synthetic-old-passphrase");
    const beforeRewrap = writes;
    const mainPath = [...objects.keys()].find(key => key.endsWith("/keys/main.json"))!;
    const remoteEnvelope = objects.get(mainPath)!.slice();
    await expect(rewrapMasterKey(client, config, masterKey, "synthetic-new-passphrase")).rejects.toThrow("does not support atomic conditional updates");
    expect(writes).toBe(beforeRewrap);
    expect(objects.get(mainPath)).toEqual(remoteEnvelope);
  } finally { db.close(); }
});
