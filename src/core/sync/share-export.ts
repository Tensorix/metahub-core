// Object-storage share export (server-side only — needs the bucket credentials
// and the blob bytes). Builds a self-contained, end-to-end-encrypted bundle for
// one doc / database under <prefix>/shares/<slug>/ and presigns every object so
// a recipient can fetch it with no credential. Decrypted in the browser viewer
// (share/share-viewer.ts) — the bucket only ever holds ciphertext.
//
// Object-storage shares are READ-ONLY (a presigned static object can't accept
// writes) and cover doc + database only (sites stay on the server transport).
//
// The share RECORD lives in the bucket, not in any local table: each share has a
// `meta.json` (encrypted with the bucket MASTER key, so only devices that hold
// the bucket can list/manage shares — recipients with just a link cannot). meta
// carries the per-share content key, which lets any bucket-holding device renew
// (re-presign) or re-copy the link without the original password.

import type { DbDriver } from "../driver.ts";
import { MhError } from "../errors.ts";
import { getDocument } from "../documents.ts";
import { getDatabase } from "../databases.ts";
import { listProperties } from "../properties.ts";
import { listRecords } from "../records.ts";
import { resolveBlob, blobContentType } from "../blobs.ts";
import { storageClientFor, type S3Config } from "./storage.ts";
import { presignGet, putBucketCors, MAX_PRESIGN_SECONDS } from "./storage-s3-bun.ts";
import {
  encryptBytes,
  decryptBytes,
  generateMasterKey,
  deriveShareKey,
  toB64,
  fromB64,
} from "./e2ee.ts";

export interface ShareManifest {
  v: 1;
  kind: "doc" | "database";
  title: string;
  body?: string;
  properties?: { id: string; name: string; type: string }[];
  records?: { cells: Record<string, unknown> }[];
  /** hash → { presigned GET of the (encrypted) blob, original content-type }. */
  blobs?: Record<string, { url: string; ct: string }>;
}

/** Bucket-resident share descriptor (master-key encrypted). The listable source
 *  of truth for an object-storage share. */
export interface BucketShareMeta {
  v: 1;
  slug: string;
  kind: "doc" | "database";
  target_id: string;
  title: string;
  permission: "view";
  created_at: number;
  /** epoch ms the presigned URLs expire (≤ 7 days out). */
  presign_exp: number;
  has_password: boolean;
  /** every object key this share owns (manifest + each blob) — for renew + delete. */
  objects: string[];
  /** base64 per-share content key (lets a bucket-holder renew / re-copy the link). */
  key: string;
  /** base64 salt (password shares); the link carries this, viewer derives the key. */
  salt?: string;
  /** epoch ms the snapshot CONTENT was last (re-)exported. Distinct from
   *  presign_exp: re-signing the link does not touch this. Older metas lack the
   *  field — readers fall back to created_at. */
  content_updated_at?: number;
}

export interface BucketShareLink {
  manifestUrl: string;
  presignExp: number;
  /** base64 random key (no-password) — goes in the link fragment as #k=. */
  keyB64?: string;
  /** base64 salt (password) — goes in the link fragment as #s=. */
  saltB64?: string;
  title: string;
}

function sharesRoot(prefix: string): string {
  const p = (prefix || "").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/shares` : "shares";
}
const metaKey = (root: string, slug: string) => `${root}/${slug}/meta.json`;
const manifestKeyOf = (root: string, slug: string) => `${root}/${slug}/manifest.bin`;
const blobKeyOf = (root: string, slug: string, hash: string) => `${root}/${slug}/blobs/${hash}`;

function blobHashes(text: string): string[] {
  const out = new Set<string>();
  const re = /\/blob\/([0-9a-f]{16,64})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]!.toLowerCase());
  return [...out];
}

// ---- meta.json (master-key encrypted) -----------------------------------------

function metaBytes(config: S3Config, meta: BucketShareMeta): Promise<Uint8Array> {
  const plain = new TextEncoder().encode(JSON.stringify(meta));
  return config.encrypt && config.masterKey
    ? encryptBytes(fromB64(config.masterKey), plain)
    : Promise.resolve(plain);
}

async function readMeta(config: S3Config, slug: string): Promise<BucketShareMeta | null> {
  const client = storageClientFor(config);
  const raw = await client.get(metaKey(sharesRoot(config.prefix), slug)).catch(() => null);
  if (!raw) return null;
  try {
    const plain = config.encrypt && config.masterKey ? await decryptBytes(fromB64(config.masterKey), raw) : raw;
    return JSON.parse(new TextDecoder().decode(plain)) as BucketShareMeta;
  } catch {
    return null;
  }
}

// ---- manifest + blobs (per-share-key encrypted) -------------------------------

/** Read the target, (re-)encrypt referenced blobs with `shareKey`, upload
 *  manifest+blobs, presign all. Returns the presigned manifest URL + object keys. */
async function writeShareObjects(
  db: DbDriver,
  opts: { slug: string; kind: "doc" | "database"; targetId: string; config: S3Config; shareKey: Uint8Array; expiresSec: number },
): Promise<{ manifestUrl: string; objects: string[]; title: string }> {
  const client = storageClientFor(opts.config);
  const root = sharesRoot(opts.config.prefix);

  const manifest: ShareManifest = { v: 1, kind: opts.kind, title: "" };
  let refHashes: string[] = [];
  if (opts.kind === "doc") {
    const doc = getDocument(db, opts.targetId);
    if (!doc) throw new MhError("not_found", `no such document: ${opts.targetId}`);
    manifest.title = doc.title;
    manifest.body = doc.body ?? "";
    refHashes = blobHashes(manifest.body);
  } else {
    const dbRow = getDatabase(db, opts.targetId);
    if (!dbRow) throw new MhError("not_found", `no such database: ${opts.targetId}`);
    manifest.title = dbRow.name;
    const props = listProperties(db, opts.targetId).sort((a, b) => a.position - b.position);
    manifest.properties = props.map((p) => ({ id: p.id, name: p.name, type: p.type }));
    const recs = listRecords(db, opts.targetId);
    manifest.records = recs.map((r) => ({ cells: r.cells }));
    refHashes = blobHashes(JSON.stringify(recs.map((r) => r.cells)));
  }

  const objects: string[] = [];
  const blobs: Record<string, { url: string; ct: string }> = {};
  for (const hash of refHashes) {
    const bytes = await resolveBlob(db, hash);
    if (!bytes) continue;
    const key = blobKeyOf(root, opts.slug, hash);
    await client.put(key, await encryptBytes(opts.shareKey, bytes), { contentType: "application/octet-stream" });
    objects.push(key);
    blobs[hash] = {
      url: await presignGet(opts.config, key, opts.expiresSec),
      ct: blobContentType(db, hash) ?? "application/octet-stream",
    };
  }
  if (Object.keys(blobs).length) manifest.blobs = blobs;

  const mKey = manifestKeyOf(root, opts.slug);
  await client.put(mKey, await encryptBytes(opts.shareKey, new TextEncoder().encode(JSON.stringify(manifest))), {
    contentType: "application/octet-stream",
  });
  objects.push(mKey);
  return { manifestUrl: await presignGet(opts.config, mKey, opts.expiresSec), objects, title: manifest.title };
}

/** Best-effort: allow the static viewer's origin to fetch this bucket's objects
 *  (cross-origin presigned GET is CORS-gated). Non-fatal — surfaced as a warning. */
async function mergeViewerCors(config: S3Config, viewerOrigin?: string): Promise<void> {
  if (!viewerOrigin) return;
  try {
    await putBucketCors(config, [viewerOrigin], { merge: true });
  } catch (e) {
    console.warn(`share: could not add viewer origin to bucket CORS (${(e as Error).message}); the viewer may be blocked until CORS allows ${viewerOrigin}`);
  }
}

// ---- public: create / renew / list / delete -----------------------------------

/** Create an object-storage share: write manifest+blobs (per-share-key encrypted)
 *  then meta.json (master-key encrypted, written LAST so a half-built share is
 *  never listed), and allow the viewer origin in the bucket's CORS. */
export async function createBucketShare(
  db: DbDriver,
  opts: {
    slug: string;
    kind: "doc" | "database";
    targetId: string;
    config: S3Config;
    password?: string | null;
    expiresSec: number;
    viewerOrigin?: string;
  },
): Promise<BucketShareLink> {
  const expiresSec = clampExpiry(opts.expiresSec);
  let shareKey: Uint8Array;
  let saltB64: string | undefined;
  if (opts.password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    shareKey = await deriveShareKey(opts.password, salt);
    saltB64 = toB64(salt);
  } else {
    shareKey = generateMasterKey();
  }

  const { manifestUrl, objects, title } = await writeShareObjects(db, {
    slug: opts.slug,
    kind: opts.kind,
    targetId: opts.targetId,
    config: opts.config,
    shareKey,
    expiresSec,
  });
  const presignExp = Date.now() + expiresSec * 1000;

  const meta: BucketShareMeta = {
    v: 1,
    slug: opts.slug,
    kind: opts.kind,
    target_id: opts.targetId,
    title,
    permission: "view",
    created_at: Date.now(),
    presign_exp: presignExp,
    has_password: !!opts.password,
    objects,
    key: toB64(shareKey),
    salt: saltB64,
    content_updated_at: Date.now(),
  };
  await storageClientFor(opts.config).put(metaKey(sharesRoot(opts.config.prefix), opts.slug), await metaBytes(opts.config, meta), {
    contentType: "application/octet-stream",
  });
  await mergeViewerCors(opts.config, opts.viewerOrigin);

  return { manifestUrl, presignExp, keyB64: opts.password ? undefined : toB64(shareKey), saltB64, title };
}

/** Renew an object-storage share: re-read the (live) source, re-encrypt with the
 *  stored per-share key, re-upload + re-presign, refresh meta.json. Works for
 *  password shares too (the key is stored master-encrypted). */
export async function renewBucketShare(
  db: DbDriver,
  config: S3Config,
  slug: string,
  expiresSec = MAX_PRESIGN_SECONDS,
): Promise<BucketShareLink> {
  const meta = await readMeta(config, slug);
  if (!meta) throw new MhError("not_found", `no such bucket share: ${slug}`);
  const shareKey = fromB64(meta.key);
  const exp = clampExpiry(expiresSec);
  const { manifestUrl, objects, title } = await writeShareObjects(db, {
    slug,
    kind: meta.kind,
    targetId: meta.target_id,
    config,
    shareKey,
    expiresSec: exp,
  });
  const presignExp = Date.now() + exp * 1000;
  const next: BucketShareMeta = {
    ...meta,
    title,
    presign_exp: presignExp,
    objects,
    content_updated_at: Date.now(),
  };
  await storageClientFor(config).put(metaKey(sharesRoot(config.prefix), slug), await metaBytes(config, next), {
    contentType: "application/octet-stream",
  });
  return { manifestUrl, presignExp, keyB64: meta.has_password ? undefined : meta.key, saltB64: meta.salt, title };
}

/** Rewrite ONLY the presigned blob URLs inside a decrypted manifest — content
 *  untouched. Pure over the presign callback (unit-testable). */
export async function refreshManifestUrls(
  manifest: ShareManifest,
  presign: (hash: string) => Promise<string>,
): Promise<ShareManifest> {
  if (!manifest.blobs) return manifest;
  const blobs: Record<string, { url: string; ct: string }> = {};
  for (const [hash, entry] of Object.entries(manifest.blobs))
    blobs[hash] = { ...entry, url: await presign(hash) };
  return { ...manifest, blobs };
}

/** Re-presign an object-storage share WITHOUT touching its content: decrypt
 *  the stored manifest, refresh the embedded blob URLs, re-encrypt in place.
 *  No live data is read and no blob bytes are re-uploaded — recipients keep
 *  seeing the same snapshot (content_updated_at stays put). This is what
 *  "renew the link" means; re-exporting current data is a separate, explicit
 *  action (renewBucketShare). */
export async function represignBucketShare(
  config: S3Config,
  slug: string,
  expiresSec = MAX_PRESIGN_SECONDS,
): Promise<BucketShareLink> {
  const meta = await readMeta(config, slug);
  if (!meta) throw new MhError("not_found", `no such bucket share: ${slug}`);
  const client = storageClientFor(config);
  const root = sharesRoot(config.prefix);
  const shareKey = fromB64(meta.key);
  const exp = clampExpiry(expiresSec);

  const mKey = manifestKeyOf(root, slug);
  const raw = await client.get(mKey).catch(() => null);
  if (!raw) throw new MhError("not_found", `bucket share ${slug} has no manifest`);
  const manifest = JSON.parse(
    new TextDecoder().decode(await decryptBytes(shareKey, raw)),
  ) as ShareManifest;
  const refreshed = await refreshManifestUrls(manifest, (hash) =>
    presignGet(config, blobKeyOf(root, slug, hash), exp),
  );
  await client.put(
    mKey,
    await encryptBytes(shareKey, new TextEncoder().encode(JSON.stringify(refreshed))),
    { contentType: "application/octet-stream" },
  );
  const presignExp = Date.now() + exp * 1000;
  await client.put(metaKey(root, slug), await metaBytes(config, { ...meta, presign_exp: presignExp }), {
    contentType: "application/octet-stream",
  });
  return {
    manifestUrl: await presignGet(config, mKey, exp),
    presignExp,
    keyB64: meta.has_password ? undefined : meta.key,
    saltB64: meta.salt,
    title: meta.title,
  };
}

/** List all object-storage shares in a bucket (decrypts each meta.json). */
export async function listBucketShares(config: S3Config): Promise<BucketShareMeta[]> {
  const client = storageClientFor(config);
  const root = sharesRoot(config.prefix);
  const entries = await client.list(`${root}/`, undefined, "/").catch(() => []);
  const slugs = entries
    .map((e) => e.key.slice(`${root}/`.length).replace(/\/$/, ""))
    .filter((s) => s && !s.includes("/"));
  const out: BucketShareMeta[] = [];
  for (const slug of slugs) {
    const meta = await readMeta(config, slug);
    if (meta) out.push(meta);
  }
  return out;
}

/** Delete a bucket share's objects. meta.json is deleted FIRST so the share
 *  immediately disappears from listings even if the rest is slow. */
export async function deleteBucketShareObjects(config: S3Config, slug: string): Promise<void> {
  const client = storageClientFor(config);
  const root = sharesRoot(config.prefix);
  await client.del(metaKey(root, slug)).catch(() => undefined);
  const meta = await readMeta(config, slug).catch(() => null); // may already be gone
  const objs = meta?.objects ?? (await client.list(`${root}/${slug}/`).catch(() => [])).map((o) => o.key);
  for (const key of objs) await client.del(key).catch(() => undefined);
}

function clampExpiry(sec: number): number {
  return Math.min(Math.max(60, Math.floor(sec)), MAX_PRESIGN_SECONDS);
}
