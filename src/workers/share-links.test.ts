import { expect, test } from "bun:test";
import { shareLinkApi, descriptor } from "../../test/helpers/share-link-api.ts";
import { generateMasterKey, toB64url } from "../core/sync/e2ee.ts";
import { linkId } from "../core/sync/share-link.ts";

async function fixture() {
  let time = Date.now();
  const api = await shareLinkApi(() => time);
  const token = toB64url(generateMasterKey());
  const id = await linkId(token);
  const url = `https://share.example/api/links/${id}`;
  const send = (
    method: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    api.handle(
      new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    ...api,
    url,
    token,
    id,
    send,
    advance: (ms: number) => (time += ms),
    now: () => time,
  };
}

test("create, resolve, optimistic renew, expiry and irreversible revoke", async () => {
  const f = await fixture();
  try {
    const d = descriptor(f.now());
    const created = await f.send("PUT", d, { "if-none-match": "*" });
    expect(created.status).toBe(201);
    const res = await f.handle(new Request(f.url));
    expect(await res.json()).toEqual(d);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(
      await f.send("PUT", d, { "if-match": '"0"' }).then((r) => r.status),
    ).toBe(409);
    f.advance(3600_001);
    expect(await f.handle(new Request(f.url)).then((r) => r.status)).toBe(410);
    // Owners can read a revision after expiry and renew the same ID.
    const expired = await f.send("GET");
    expect(expired.status).toBe(200);
    expect(
      await f
        .send("PUT", descriptor(f.now()), {
          "if-match": expired.headers.get("etag")!,
        })
        .then((r) => r.status),
    ).toBe(200);
    expect(await f.handle(new Request(f.url)).then((r) => r.status)).toBe(200);
    expect(await f.send("DELETE").then((r) => r.status)).toBe(200);
    expect(await f.handle(new Request(f.url)).then((r) => r.status)).toBe(410);
    expect(
      await f
        .send("PUT", descriptor(f.now()), { "if-match": '"3"' })
        .then((r) => r.status),
    ).toBe(410);
    const row = f.db.query("SELECT * FROM share_links").get() as Record<
      string,
      unknown
    >;
    expect(row.descriptor).toBe("{}");
    expect(JSON.stringify(row)).not.toContain(f.token);
  } finally {
    f.db.close();
  }
});

test("capability is mandatory and binds the ID, including before creation", async () => {
  const f = await fixture();
  try {
    for (const method of ["PUT", "DELETE"]) {
      const response = await f.handle(
        new Request(f.url, {
          method,
          headers: { authorization: `Bearer ${toB64url(generateMasterKey())}` },
        }),
      );
      expect(response.status).toBe(401);
    }
    // A revoke racing ahead of first registration still leaves a tombstone.
    await f.send("DELETE");
    expect(
      await f
        .send("PUT", descriptor(), { "if-none-match": "*" })
        .then((r) => r.status),
    ).toBe(410);
  } finally {
    f.db.close();
  }
});

test("rejects keys, unsigned/non-HTTPS URLs, oversized bodies and excessive expiry", async () => {
  const f = await fixture();
  try {
    const d = descriptor();
    for (const body of [
      { ...d, key: "must-not-be-persisted" },
      { ...d, password: "secret" },
      { ...d, manifestUrl: "https://bucket.example/unsigned" },
      { ...d, manifestUrl: d.manifestUrl.replace("https:", "http:") },
      { ...d, manifestUrl: `${d.manifestUrl}#secret` },
      { ...d, expiresAt: d.expiresAt + 1 },
    ])
      expect(
        await f
          .send("PUT", body, { "if-none-match": "*" })
          .then((r) => r.status),
      ).toBe(400);
    expect(
      await f
        .send("PUT", { x: "x".repeat(13_000) }, { "if-none-match": "*" })
        .then((r) => r.status),
    ).toBe(413);
    expect(f.db.query("SELECT count(*) AS n FROM share_links").get()).toEqual({
      n: 0,
    });
  } finally {
    f.db.close();
  }
});

test("CORS supports browser owner calls and registration rate limits are atomic", async () => {
  const { db, handle } = await shareLinkApi();
  try {
    const options = await handle(
      new Request("https://share.example/api/links/AAAAAAAAAAAAAAAAAAAAAA", {
        method: "OPTIONS",
      }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
    const statuses = await Promise.all(
      Array.from({ length: 62 }, async () => {
        const token = toB64url(generateMasterKey());
        return handle(
          new Request(
            `https://share.example/api/links/${await linkId(token)}`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "if-none-match": "*",
                "cf-connecting-ip": "192.0.2.1",
              },
              body: JSON.stringify(descriptor()),
            },
          ),
        ).then((r) => r.status);
      }),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  } finally {
    db.close();
  }
});
