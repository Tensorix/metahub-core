import {
  decryptBytes,
  encryptBytes,
  fromB64,
  generateMasterKey,
  toB64url,
} from "./e2ee.ts";
import { storageClientFor, type S3Config } from "./storage.ts";
import {
  linkId,
  longShareUrl,
  signedUrlExpiry,
  tokenHash,
} from "./share-link.ts";
import type { BucketShareLink } from "./share-export.ts";

interface Control {
  v: 1;
  base: string;
  token: string;
}
const TIMEOUT = 8000;
function root(config: S3Config, slug: string): string {
  return `${config.prefix.replace(/^\/+|\/+$/g, "") ? `${config.prefix.replace(/^\/+|\/+$/g, "")}/` : ""}shares/${slug}/links/`;
}
function viewerBase(base: string): string {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("invalid viewer");
  // Short-link API is served at the viewer's root. Subpath static hosts retain
  // their original long-link behavior.
  if (url.pathname !== "/") throw new Error("static subpath viewer");
  return url.origin;
}
async function unpack(config: S3Config, bytes: Uint8Array): Promise<Control> {
  const raw =
    config.encrypt && config.masterKey
      ? await decryptBytes(fromB64(config.masterKey), bytes)
      : bytes;
  const value = JSON.parse(new TextDecoder().decode(raw)) as Control;
  if (
    value.v !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    viewerBase(value.base) !== value.base
  )
    throw new Error("invalid short-link control");
  return value;
}

/** Independent owner capability, never derived from a recipient's content key.
 * A separate private object avoids racing with snapshot/manifest meta updates.
 * Conditional creation makes concurrent devices agree on the same identity. */
async function controlFor(
  config: S3Config,
  slug: string,
  base: string,
): Promise<Control> {
  const client = storageClientFor(config);
  const path = `${root(config, slug)}${await tokenHash(base)}.json`;
  const existing = await client.get(path);
  if (existing) {
    const control = await unpack(config, existing);
    if (control.base !== base) throw new Error("viewer mismatch");
    return control;
  }
  const control: Control = { v: 1, base, token: toB64url(generateMasterKey()) };
  const plain = new TextEncoder().encode(JSON.stringify(control));
  const bytes =
    config.encrypt && config.masterKey
      ? await encryptBytes(fromB64(config.masterKey), plain)
      : plain;
  try {
    await client.put(path, bytes, {
      ifNoneMatch: true,
      contentType: "application/octet-stream",
    });
  } catch (error) {
    const winner = await client.get(path);
    if (!winner) throw error;
    const value = await unpack(config, winner);
    if (value.base !== base) throw new Error("viewer mismatch");
    return value;
  }
  return control;
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** Static/self-hosted viewers without this API continue to get legacy links. */
export async function bucketShareUrl(
  config: S3Config,
  slug: string,
  base: string,
  link: BucketShareLink,
): Promise<string> {
  const fallback = longShareUrl(base, link);
  try {
    const origin = viewerBase(base);
    const expiresAt = Math.min(
      link.presignExp,
      signedUrlExpiry(link.manifestUrl) ?? 0,
    );
    if (expiresAt <= Date.now()) return fallback;
    const probe = await request(`${origin}/api/links`);
    if (
      !probe.ok ||
      ((await probe.json()) as { service?: string }).service !==
        "metahub-share-links"
    )
      throw new Error("static viewer");
    const control = await controlFor(config, slug, origin);
    const id = await linkId(control.token);
    const endpoint = `${origin}/api/links/${id}`;
    const authorization = `Bearer ${control.token}`;
    const descriptor = {
      v: 1,
      manifestUrl: link.manifestUrl,
      expiresAt,
      ...(link.saltB64 ? { salt: toB64url(fromB64(link.saltB64)) } : {}),
    };
    // Read the revision before writing. A stale concurrent writer must not
    // silently replace the winner's newer presigned URLs.
    const current = await request(endpoint, { headers: { authorization } });
    if (!current.ok && current.status !== 404)
      throw new Error("short-link lookup failed");
    const etag = current.headers.get("etag");
    if (current.ok && !etag) throw new Error("not a short-link API");
    const result = await request(endpoint, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/json",
        ...(current.ok ? { "if-match": etag! } : { "if-none-match": "*" }),
      },
      body: JSON.stringify(descriptor),
    });
    if (
      !result.ok ||
      !result.headers.get("etag") ||
      ((await result.json()) as { ok?: boolean }).ok !== true
    )
      throw new Error("short-link registration failed");
    return `${origin}/s/${id}${link.keyB64 ? `#k=${toB64url(fromB64(link.keyB64))}` : ""}`;
  } catch {
    // Do not log the exception: fetch errors can contain presigned URLs.
    console.warn(
      "share: short-link service unavailable; using the original long link",
    );
    return fallback;
  }
}

/** Confirm every published alias is revoked before removing its owner controls.
 * Failure leaves controls in the bucket, so another device can retry safely. */
export async function revokeBucketShortLinks(
  config: S3Config,
  slug: string,
): Promise<void> {
  const client = storageClientFor(config);
  for (const object of await client.list(root(config, slug))) {
    if (!object.key.endsWith(".json")) continue;
    const raw = await client.get(object.key);
    if (!raw) continue;
    const control = await unpack(config, raw);
    const response = await request(
      `${control.base}/api/links/${await linkId(control.token)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${control.token}` },
      },
    );
    if (
      !response.ok ||
      ((await response.json()) as { ok?: boolean }).ok !== true
    )
      throw new Error(
        "short-link revocation has not been confirmed; retry later",
      );
  }
}
