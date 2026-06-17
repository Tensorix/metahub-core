// Browser blob byte store — offline document images for a replica client.
//
// One module across three contexts (the window via api.ts, the DB worker, and the
// service worker): all three share WebCrypto, the same origin-scoped IndexedDB,
// and the same Cache Storage. No imports from core/ or api.ts so it stays
// portable and safe to bundle into the standalone service worker.
//
//   - blobHash32: content hash identical to the server's (core/cache.ts blobHash
//     = sha256 truncated to 32 hex), so an image composed offline gets the SAME
//     /blob/<hash> URL it will have once uploaded — the offline and server copies
//     coincide and dedupe.
//   - spool (IndexedDB): bytes composed while offline, durable=0 until drained to
//     the server (POST /api/blob) or a bucket (putBucketBlob). The ONLY copy while
//     pending, so it is never evicted.
//   - byte cache (Cache Storage `mh-blob-v1` + an IndexedDB LRU index): a bounded
//     store of fetched/served blob bytes, evicted least-recently-used over a quota.

export const BLOB_CACHE = "mh-blob-v1";
/** Over this many cached bytes the LRU index evicts oldest entries down to ~80%. */
export const BLOB_QUOTA_BYTES = 200 * 1024 * 1024;
const BLOB_LOW_WATER = Math.floor(BLOB_QUOTA_BYTES * 0.8);

const IDB_NAME = "mh-blobs";
const IDB_VERSION = 1;
const SPOOL = "spool";
const META = "meta";

// ---- content hash + type -----------------------------------------------------

/** A standalone ArrayBuffer of exactly these bytes — keeps crypto.subtle.digest
 *  off the generic Uint8Array<ArrayBufferLike> that BufferSource won't accept. */
function ab(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ab(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical content hash (sha256 → 32 hex), matching core/cache.ts blobHash so
 *  offline-composed and server-stored copies of the same bytes share one URL. */
export async function blobHash32(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 32);
}

/** Bytes match a content ref of either length (canonical 32-hex or legacy 64-hex):
 *  the ref is always a prefix of the full sha256. Mirrors core/cache.ts
 *  verifyBlobBytes but with WebCrypto (the core one uses Bun, unavailable here). */
export async function verifyBytes(bytes: Uint8Array | ArrayBuffer, hash: string): Promise<boolean> {
  return (await sha256Hex(bytes)).slice(0, hash.length) === hash;
}

const EXT_CT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** Content type from a URL/file suffix (same map serveBlob uses), default octet. */
export function inferBlobType(nameOrPath: string): string {
  const dot = nameOrPath.lastIndexOf(".");
  const ext = dot >= 0 ? nameOrPath.slice(dot + 1).toLowerCase() : "";
  return EXT_CT[ext] ?? "application/octet-stream";
}

/** File extension for a content type (for building /blob/<hash>.<ext>); "" when unknown. */
export function extForType(ct: string): string {
  const t = ct.toLowerCase().split(";")[0]!.trim();
  for (const [ext, type] of Object.entries(EXT_CT)) {
    if (type === t && ext !== "jpeg") return ext; // prefer jpg over jpeg
  }
  return "";
}

// ---- IndexedDB plumbing ------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, IDB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SPOOL)) db.createObjectStore(SPOOL, { keyPath: "hash" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "hash" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

function txn<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(store, mode).objectStore(store));
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      }),
  );
}

// ---- spool (offline-composed bytes, pending durability) ----------------------

export interface SpoolBlob {
  hash: string;
  bytes: ArrayBuffer;
  content_type: string;
  created: number;
  /** 0 = pending (only copy, never evicted); 1 = drained to server/bucket. */
  durable: number;
}

export async function spoolPut(hash: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  const entry: SpoolBlob = { hash, bytes, content_type: contentType, created: Date.now(), durable: 0 };
  await txn(SPOOL, "readwrite", (s) => s.put(entry));
}

export function spoolGet(hash: string): Promise<SpoolBlob | undefined> {
  return txn<SpoolBlob | undefined>(SPOOL, "readonly", (s) => s.get(hash));
}

/** Spool entries not yet drained to a durable home (server / bucket). */
export async function spoolPending(): Promise<SpoolBlob[]> {
  const all = await txn<SpoolBlob[]>(SPOOL, "readonly", (s) => s.getAll());
  return (all ?? []).filter((e) => !e.durable);
}

export async function spoolDelete(hash: string): Promise<void> {
  await txn(SPOOL, "readwrite", (s) => s.delete(hash));
}

// ---- bounded byte cache (Cache Storage + LRU index) --------------------------

interface MetaRow {
  hash: string;
  size: number;
  accessed: number;
  pinned: number;
}

const cacheKey = (hash: string) => `/blob/${hash}`;

async function metaPut(hash: string, size: number): Promise<void> {
  const cur = await txn<MetaRow | undefined>(META, "readonly", (s) => s.get(hash));
  const row: MetaRow = { hash, size, accessed: Date.now(), pinned: cur?.pinned ?? 0 };
  await txn(META, "readwrite", (s) => s.put(row));
}

async function metaTouch(hash: string): Promise<void> {
  const cur = await txn<MetaRow | undefined>(META, "readonly", (s) => s.get(hash));
  if (!cur) return;
  cur.accessed = Date.now();
  await txn(META, "readwrite", (s) => s.put(cur));
}

/** Pin/unpin a cached blob so the LRU never evicts it (browser-local pin). */
export async function setCachePinned(hash: string, pinned: boolean): Promise<boolean> {
  const cur = await txn<MetaRow | undefined>(META, "readonly", (s) => s.get(hash));
  if (!cur) return false;
  cur.pinned = pinned ? 1 : 0;
  await txn(META, "readwrite", (s) => s.put(cur));
  return true;
}

/** A `text/*` body never is a blob — it's a poisoned entry (an SPA-fallback
 *  index.html, an unlock/login page, or a captive-portal interstitial that a
 *  prior `res.ok`-only write captured under a blob hash). Treated as a miss and
 *  purged on read so an already-poisoned device self-heals without clearing
 *  storage (the refetch goes through the now hash-verified write path). */
export function isPoisonContentType(ct: string): boolean {
  return ct.trim().toLowerCase().startsWith("text/");
}

/** A cached blob's bytes, or undefined on miss. Bumps its LRU access time.
 *  A poisoned (text/*) hit is deleted and reported as a miss — see above. */
export async function cacheGet(hash: string): Promise<Response | undefined> {
  const c = await caches.open(BLOB_CACHE);
  const hit = await c.match(cacheKey(hash));
  if (!hit) return undefined;
  if (isPoisonContentType(hit.headers.get("content-type") ?? "")) {
    await c.delete(cacheKey(hash));
    await txn(META, "readwrite", (s) => s.delete(hash)).catch(() => {});
    return undefined;
  }
  void metaTouch(hash);
  return hit;
}

/** Store bytes in the bounded cache and record them in the LRU index, then evict. */
export async function cachePut(hash: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  const c = await caches.open(BLOB_CACHE);
  await c.put(
    cacheKey(hash),
    new Response(bytes, {
      headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
    }),
  );
  await metaPut(hash, bytes.byteLength);
  await evictCache();
}

/** Evict least-recently-used unpinned entries until the cache is under low-water. */
export async function evictCache(): Promise<void> {
  const rows = (await txn<MetaRow[]>(META, "readonly", (s) => s.getAll())) ?? [];
  let total = rows.reduce((n, r) => n + r.size, 0);
  if (total <= BLOB_QUOTA_BYTES) return;
  const c = await caches.open(BLOB_CACHE);
  const victims = rows.filter((r) => !r.pinned).sort((a, b) => a.accessed - b.accessed);
  for (const r of victims) {
    if (total <= BLOB_LOW_WATER) break;
    await c.delete(cacheKey(r.hash));
    await txn(META, "readwrite", (s) => s.delete(r.hash));
    total -= r.size;
  }
}
