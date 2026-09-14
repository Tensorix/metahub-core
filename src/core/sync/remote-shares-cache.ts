import type { DbDriver } from "../driver.ts";
import { listPeers, type PeerRow } from "./peers.ts";
import { listBucketShares, type BucketShareMeta } from "./share-export.ts";
import type { S3Config } from "./storage.ts";
import type { ShareListItem } from "./share-actions.ts";

export type RemoteShareMode = "fresh" | "cached";

export interface RemoteShareSource {
  url: string;
  kind: "bucket" | "peer";
  peer: PeerRow;
}

interface SourceEntry {
  items: ShareListItem[];
  fetchedAt: number;
  error: string | null;
  inflight: Promise<void> | null;
}

const caches = new WeakMap<object, Map<string, SourceEntry>>();
const listeners = new Set<(db: object) => void>();
export const REMOTE_SHARES_STALE_MS = 60_000;
const PEER_LIST_TIMEOUT_MS = 4000;

export function absoluteShareUrl(url: string, base: string): string {
  try {
    return new URL(url, `${base.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

export function bucketShareItem(bucket: { url: string; label: string | null }, m: BucketShareMeta): ShareListItem {
  return {
    slug: m.slug,
    kind: m.kind,
    target_id: m.target_id,
    title: m.title || m.target_id,
    permission: m.permission,
    transport: "s3",
    source: `桶 ${bucket.label ?? bucket.url}`,
    sourceKind: "bucket",
    hosting: "s3",
    expiresAt: m.presign_exp,
    hasPassword: m.has_password,
    contentUpdatedAt: m.content_updated_at ?? m.created_at,
  };
}

export async function fetchPeerShares(url: string, token: string, targetId?: string): Promise<ShareListItem[]> {
  const u = `${url.replace(/\/+$/, "")}/api/shares${targetId ? `?target=${encodeURIComponent(targetId)}` : ""}`;
  const res = await Promise.race([
    fetch(u, { headers: { authorization: `Bearer ${token}` } }),
    new Promise<Response>((_r, rej) => setTimeout(() => rej(new Error("timeout")), PEER_LIST_TIMEOUT_MS)),
  ]);
  if (!res.ok) return [];
  return ((await res.json()) as ShareListItem[]).map((item) => ({
    ...item,
    ...(item.url ? { url: absoluteShareUrl(item.url, url) } : {}),
  }));
}

export function remoteShareSources(db: DbDriver): RemoteShareSource[] {
  return listPeers(db).flatMap((p): RemoteShareSource[] => {
    if (p.kind === "s3" && p.config) return [{ url: p.url, kind: "bucket", peer: p }];
    if (p.kind === "http" && p.token) return [{ url: p.url, kind: "peer", peer: p }];
    return [];
  });
}

async function fetchSource(s: RemoteShareSource): Promise<ShareListItem[]> {
  if (s.kind === "bucket") {
    const config = JSON.parse(s.peer.config!) as S3Config;
    return (await listBucketShares(config)).map((m) => bucketShareItem(s.peer, m));
  }
  return (await fetchPeerShares(s.url, s.peer.token!)).map((it) => ({
    ...it,
    source: s.peer.label ?? s.url,
    sourceKind: "peer" as const,
    sourceUrl: s.url,
  }));
}

function cacheFor(db: object): Map<string, SourceEntry> {
  let m = caches.get(db);
  if (!m) {
    m = new Map();
    caches.set(db, m);
  }
  return m;
}

function entryFor(db: object, url: string): SourceEntry {
  const m = cacheFor(db);
  let e = m.get(url);
  if (!e) {
    e = { items: [], fetchedAt: 0, error: null, inflight: null };
    m.set(url, e);
  }
  return e;
}

function notify(db: object): void {
  for (const fn of [...listeners]) fn(db);
}

export function onRemoteSharesChanged(fn: (db: object) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function refreshRemoteSource(db: DbDriver, s: RemoteShareSource): Promise<void> {
  const e = entryFor(db, s.url);
  if (e.inflight) return e.inflight;
  e.inflight = fetchSource(s)
    .then((items) => {
      const changed = JSON.stringify(items) !== JSON.stringify(e.items);
      e.items = items;
      e.error = null;
      e.fetchedAt = Date.now();
      if (changed) notify(db);
    })
    .catch((err: unknown) => {
      e.error = err instanceof Error ? err.message : String(err);
      e.fetchedAt = Date.now();
    })
    .finally(() => {
      e.inflight = null;
    });
  return e.inflight;
}

export function refreshRemoteShares(db: DbDriver): Promise<void> {
  return Promise.all(remoteShareSources(db).map((s) => refreshRemoteSource(db, s))).then(() => undefined);
}

export function cachedRemoteShares(
  db: DbDriver,
  targetId?: string,
  opts: { now?: number; refresh?: boolean } = {},
): ShareListItem[] {
  const now = opts.now ?? Date.now();
  const sources = remoteShareSources(db);
  const m = cacheFor(db);
  const live = new Set(sources.map((s) => s.url));
  for (const key of [...m.keys()]) if (!live.has(key)) m.delete(key);
  const out: ShareListItem[] = [];
  for (const s of sources) {
    const e = entryFor(db, s.url);
    if (opts.refresh !== false && !e.inflight && now - e.fetchedAt >= REMOTE_SHARES_STALE_MS)
      void refreshRemoteSource(db, s);
    for (const it of e.items) if (!targetId || it.target_id === targetId) out.push(it);
  }
  return out;
}

export function primeRemoteShare(db: object, url: string, item: ShareListItem): void {
  const e = entryFor(db, url);
  e.items = [...e.items.filter((it) => it.slug !== item.slug), item];
}

export function dropRemoteShare(db: object, url: string, slug: string): void {
  const e = caches.get(db)?.get(url);
  if (e) e.items = e.items.filter((it) => it.slug !== slug);
}

export function findCachedBucketShare(
  db: DbDriver,
  slug: string,
): { source: RemoteShareSource; item: ShareListItem } | null {
  const m = caches.get(db);
  if (!m) return null;
  for (const s of remoteShareSources(db)) {
    if (s.kind !== "bucket") continue;
    const item = m.get(s.url)?.items.find((it) => it.slug === slug);
    if (item) return { source: s, item };
  }
  return null;
}
