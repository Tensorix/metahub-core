// Run against a LOCAL Pages dev server with a migrated throwaway D1 database.
import { linkId } from "../src/core/sync/share-link.ts";
import { generateMasterKey, toB64url } from "../src/core/sync/e2ee.ts";

const origin = new URL(process.argv[2] ?? "http://localhost:8788");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  throw new Error("Smoke test only supports a local server");
const token = toB64url(generateMasterKey());
const id = await linkId(token);
const endpoint = new URL(`/api/links/${id}`, origin);
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const time = Math.floor(Date.now() / 1000) * 1000;
const date = new Date(time)
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}/, "");
const descriptor = {
  v: 1,
  manifestUrl: `https://example.invalid/manifest.bin?X-Amz-Date=${date}&X-Amz-Expires=3600&X-Amz-Signature=${"a".repeat(64)}`,
  expiresAt: time + 3600_000,
};
const home = await fetch(origin);
assert(
  home.ok && (await home.text()).includes('src="./share-viewer.js"'),
  "legacy root shell",
);
for (const path of [`/s/${id}`, `/s/${id}/`]) {
  const page = await fetch(new URL(path, origin));
  assert(!page.redirected && new URL(page.url).pathname === path, "deep link must preserve its ID in the address bar");
  const html = await page.text();
  assert(
    page.ok &&
      html.includes('src="/share-viewer.js"') &&
      html.includes('href="/favicon.png"'),
    "deep-link shell must load absolute assets",
  );
}
const js = await fetch(new URL("/share-viewer.js", origin));
assert(
  js.ok && (js.headers.get("content-type") ?? "").includes("javascript"),
  "viewer JS asset",
);
const create = await fetch(endpoint, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "if-none-match": "*",
  },
  body: JSON.stringify(descriptor),
});
assert(
  create.status === 201,
  `D1 create: ${create.status} ${await create.text()}`,
);
const read = await fetch(endpoint);
assert(
  read.ok && read.headers.get("cache-control") === "no-store",
  "D1 read and cache policy",
);
assert(
  ((await read.json()) as typeof descriptor).manifestUrl ===
    descriptor.manifestUrl,
  "D1 descriptor roundtrip",
);
const renew = await fetch(endpoint, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "if-match": read.headers.get("etag")!,
  },
  body: JSON.stringify(descriptor),
});
assert(renew.ok, "D1 update with revision");
assert(
  (await fetch(endpoint, { method: "DELETE" })).status === 401,
  "unauthorized deletion",
);
assert(
  (
    await fetch(endpoint, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    })
  ).ok,
  "owner revocation",
);
assert((await fetch(endpoint)).status === 410, "revoked ID must not resolve");
console.log(
  "Pages/workerd smoke passed: root + deep links + assets + D1 create/read/renew/revoke.",
);
