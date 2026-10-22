import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { shareLinkApi } from "../../../test/helpers/share-link-api.ts";
import { bucketShareUrl } from "./share-short-links.ts";
import {
  createBucketShare,
  deleteBucketShareObjects,
  listBucketShares,
  represignBucketShare,
  renewBucketShare,
} from "./share-export.ts";
import {
  setStorageClientFactory,
  type S3Config,
  type StorageClient,
} from "./storage.ts";
import { decryptBytes, fromB64, generateMasterKey, toB64 } from "./e2ee.ts";
import { decodeLinkKey } from "./share-link.ts";
import { loadShareLink } from "../../webui/share/share-link-loader.ts";
import { initSchema } from "../schema-init.ts";
import { createDocument } from "../documents.ts";
import { bucketShareItem } from "./remote-shares-cache.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function fixture(password?: string) {
  const api = await shareLinkApi();
  const db = new Database(":memory:");
  initSchema(db);
  const doc = createDocument(db, {
    title: "Private title",
    body: "private document body",
  });
  const config: S3Config = {
    endpoint: "https://bucket.example",
    bucket: "test",
    prefix: "metahub",
    region: "auto",
    accessKeyId: "synthetic-access",
    secretAccessKey: "synthetic-secret",
    encrypt: true,
    masterKey: toB64(generateMasterKey()),
  };
  const store = new Map<string, Uint8Array>();
  const client: StorageClient = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, bytes, opts) => {
      if (opts?.ifNoneMatch && store.has(key)) throw new Error("conflict");
      store.set(key, bytes);
    },
    list: async (prefix, _after, delimiter) =>
      [
        ...new Set(
          [...store.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => {
              if (!delimiter) return key;
              const i = key.indexOf(delimiter, prefix.length);
              return i < 0 ? key : key.slice(0, i + delimiter.length);
            }),
        ),
      ].map((key) => ({ key })),
    del: async (key) => {
      store.delete(key);
    },
  };
  setStorageClientFactory(() => client);
  const traces: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    traces.push(`${request.url}\n${await request.clone().text()}`);
    return api.handle(request);
  }) as typeof fetch;
  const link = await createBucketShare(db, {
    slug: "example",
    kind: "doc",
    targetId: doc.id,
    config,
    expiresSec: 3600,
    password,
  });
  return {
    api,
    db,
    config,
    store,
    client,
    link,
    traces,
    close() {
      db.close();
      api.db.close();
    },
  };
}

test("owner → D1 → viewer roundtrip, stable cross-device renewal, no content secrets in API", async () => {
  const f = await fixture();
  try {
    const url = await bucketShareUrl(
      f.config,
      "example",
      "https://viewer.example",
      f.link,
    );
    expect(url).toMatch(
      /^https:\/\/viewer.example\/s\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/,
    );
    const loaded = await loadShareLink(new URL(url));
    expect(decodeLinkKey(loaded.k!)).toEqual(fromB64(f.link.keyB64!));
    const body = await decryptBytes(
      decodeLinkKey(loaded.k!),
      f.store.get("metahub/shares/example/manifest.bin")!,
    );
    expect(new TextDecoder().decode(body)).toContain("private document body");
    // Another device uses only bucket state, including the independent owner control.
    const renewed = await represignBucketShare({ ...f.config }, "example");
    expect(
      await bucketShareUrl(
        { ...f.config },
        "example",
        "https://viewer.example",
        renewed,
      ),
    ).toBe(url);
    expect(
      f.api.db.query("SELECT count(*) AS n FROM share_links").get(),
    ).toEqual({ n: 1 });
    const wire = f.traces.join("\n");
    for (const secret of [
      f.link.keyB64!,
      new URL(url).hash.slice(3),
      f.config.masterKey!,
      f.config.secretAccessKey,
      "private document body",
      "Private title",
    ])
      expect(wire).not.toContain(secret);
    const controlPath = [...f.store.keys()].find((k) => k.includes("/links/"))!;
    expect(() =>
      JSON.parse(new TextDecoder().decode(f.store.get(controlPath)!)),
    ).toThrow();
    expect(await loadShareLink(new URL(url))).toMatchObject({ k: loaded.k });
    await deleteBucketShareObjects(f.config, "example");
    expect(f.store.size).toBe(0);
    await expect(loadShareLink(new URL(url))).rejects.toThrow(
      "share_unavailable",
    );
  } finally {
    f.close();
  }
});

test("password short link has no key or salt in URL and password never reaches API", async () => {
  const f = await fixture("private-password");
  try {
    const url = await bucketShareUrl(
      f.config,
      "example",
      "https://viewer.example",
      f.link,
    );
    expect(new URL(url).hash).toBe("");
    expect(new URL(url).search).toBe("");
    const loaded = await loadShareLink(new URL(url));
    expect(loaded.k).toBeUndefined();
    expect(decodeLinkKey(loaded.s!)).toEqual(fromB64(f.link.saltB64!));
    expect(f.traces.join("\n")).not.toContain("private-password");
  } finally {
    f.close();
  }
});

test("static hosts and API failures fall back to legacy links without leaking key", async () => {
  const f = await fixture();
  try {
    globalThis.fetch = (async () =>
      new Response("<html>static viewer</html>")) as typeof fetch;
    const staticUrl = await bucketShareUrl(
      f.config,
      "example",
      "https://static.example",
      f.link,
    );
    expect(staticUrl).toContain("/#m=");
    expect((await loadShareLink(new URL(staticUrl))).k).toBe(f.link.keyB64);
    expect([...f.store.keys()].some((k) => k.includes("/links/"))).toBe(false);
    globalThis.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname === "/api/links")
        return f.api.handle(new Request(input, init));
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    expect(
      await bucketShareUrl(
        f.config,
        "example",
        "https://viewer.example",
        f.link,
      ),
    ).toContain("/#m=");
  } finally {
    f.close();
  }
});

test("failed revoke remains discoverable, disallows renew, and succeeds on retry", async () => {
  const f = await fixture();
  try {
    await bucketShareUrl(f.config, "example", "https://viewer.example", f.link);
    const onlineFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 503 })) as typeof fetch;
    await expect(deleteBucketShareObjects(f.config, "example")).rejects.toThrow(
      "revocation",
    );
    const metas = await listBucketShares(f.config);
    expect(metas).toHaveLength(1);
    expect(
      bucketShareItem({ url: "s3://test", label: "test" }, metas[0]!).lifecycle,
    ).toBe("cleanup_pending");
    await expect(represignBucketShare(f.config, "example")).rejects.toThrow(
      "revocation is pending",
    );
    await expect(renewBucketShare(f.db, f.config, "example")).rejects.toThrow(
      "revocation is pending",
    );
    globalThis.fetch = onlineFetch;
    await deleteBucketShareObjects(f.config, "example");
    expect(f.store.size).toBe(0);
  } finally {
    f.close();
  }
});

test("concurrent first registration shares one owner control and does not overwrite revisions", async () => {
  const f = await fixture();
  try {
    const urls = await Promise.all(
      Array.from({ length: 4 }, () =>
        bucketShareUrl(f.config, "example", "https://viewer.example", f.link),
      ),
    );
    expect(urls.some((url) => url.includes("/s/"))).toBe(true);
    expect(
      f.api.db.query("SELECT count(*) AS n FROM share_links").get(),
    ).toEqual({ n: 1 });
    expect(
      [...f.store.keys()].filter((k) => k.includes("/links/")),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
