import { expect, test } from "bun:test";
import { loadShareLink } from "./share-link-loader.ts";
import { decodeLinkKey } from "../../core/sync/share-link.ts";
import { descriptor } from "../../../test/helpers/share-link-api.ts";
import { toB64, toB64url } from "../../core/sync/e2ee.ts";

test("legacy base64 keys and password salts preserve '+' and never call the API", async () => {
  const raw = new Uint8Array(32).fill(251);
  for (const mode of ["k", "s"]) {
    const url = new URL(
      `https://viewer.example/#m=${encodeURIComponent("https://bucket.example/file?x=1&y=2")}&${mode}=${toB64(raw)}`,
    );
    const out = await loadShareLink(url, (() => {
      throw new Error("must stay offline");
    }) as typeof fetch);
    expect(out.m).toBe("https://bucket.example/file?x=1&y=2");
    expect(decodeLinkKey(mode === "k" ? out.k! : out.s!)).toEqual(raw);
  }
});

test("short link resolves only the ID; content key never enters the request", async () => {
  const key = toB64url(new Uint8Array(32).fill(251));
  const data = descriptor();
  const result = await loadShareLink(
    new URL(`https://viewer.example/s/AAAAAAAAAAAAAAAAAAAAAA#k=${key}`),
    (async (input, init) => {
      expect(String(input)).toBe(
        "https://viewer.example/api/links/AAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(JSON.stringify(init)).not.toContain(key);
      expect(init?.credentials).toBe("omit");
      return Response.json(data);
    }) as typeof fetch,
  );
  expect(result).toEqual({ m: data.manifestUrl, k: key, s: undefined });
});

test("password short links use the returned salt and reject expired or malformed responses", async () => {
  const url = new URL("https://viewer.example/s/AAAAAAAAAAAAAAAAAAAAAA");
  const data = { ...descriptor(), salt: toB64url(new Uint8Array(16).fill(1)) };
  expect(
    (
      await loadShareLink(url, (async () =>
        Response.json(data)) as typeof fetch)
    ).s,
  ).toBe(data.salt);
  for (const response of [
    Response.json(data, { status: 410 }),
    Response.json({ ...data, expiresAt: 1 }),
    Response.json({ ...data, key: "unexpected" }),
  ]) {
    await expect(
      loadShareLink(url, (async () => response) as typeof fetch),
    ).rejects.toThrow("share_unavailable");
  }
});
