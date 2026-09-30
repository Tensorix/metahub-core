// Synchronous title lookup for `[[doc_x]]` / `[[db_x]]` internal references.
//
// CM6 decorations are built synchronously, so the editor needs an in-memory
// id → title map. App.reloadNav() primes it for free from the nav lists it
// already fetches (primeDocTitles); contexts without the full app shell (quick
// notes window, tests) fall back to a lazy self-refresh on first lookup.
// NAV_INVALIDATE (any successful mutation, incl. renames) marks the map stale;
// stale lookups keep serving the old titles (no flicker on autosave) while a
// refresh runs, and subscribers are notified only when a title actually changed.

import { api, NAV_INVALIDATE, type DocSummary, type Db } from "./api";

const titles = new Map<string, string>();
const owners = new Map<string, { parent_id: string | null; database_id: string | null }>();
let state: "empty" | "fresh" | "stale" = "empty";
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Notify on title-map changes; returns the unsubscribe. */
export function onDocTitleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fill the map from lists the caller already holds (App.reloadNav). */
export function primeDocTitles(docs: DocSummary[], dbs: Db[]): void {
  const next = new Map<string, string>();
  owners.clear();
  for (const d of docs) {
    next.set(d.id, d.title ?? "");
    owners.set(d.id, { parent_id: d.parent_id ?? null, database_id: d.database_id ?? null });
  }
  for (const d of dbs) next.set(d.id, d.name ?? "");
  const changed =
    state === "empty" ||
    next.size !== titles.size ||
    [...next].some(([id, t]) => titles.get(id) !== t);
  titles.clear();
  for (const [id, t] of next) titles.set(id, t);
  state = "fresh";
  if (changed) for (const fn of listeners) fn();
}

/** Every known target for the `[[` suggest menu (docs and dbs, nav order).
 *  Empty while the map is first loading — a refresh is kicked and
 *  onDocTitleChange fires when entries arrive. */
export function allDocTitles(): { id: string; title: string }[] {
  if (state === "empty") void refresh();
  return [...titles].map(([id, title]) => ({ id, title }));
}

/** Sync lookup: the current title (may be ""), null when the target is known
 *  missing, undefined while the map is first loading (a refresh is kicked). */
export function docLinkTitle(id: string): string | null | undefined {
  if (state === "empty") {
    void refresh();
    return undefined;
  }
  if (state === "stale") void refresh();
  return titles.get(id) ?? null;
}

/** Seed one known title (e.g. a document the doc-cell picker just created) so
 *  its chip never flashes the raw id while the map refreshes. */
export function primeDocTitle(id: string, title: string): void {
  if (state === "empty") return; // the first load will include it anyway
  titles.set(id, title);
  if (state === "fresh") state = "stale";
  for (const fn of listeners) fn();
}

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [docs, dbs] = await Promise.all([api.listDocuments(), api.listDatabases()]);
      primeDocTitles(docs, dbs);
    } catch {
      // Offline/unauthorized: keep whatever we have; the next lookup retries.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

if (typeof document !== "undefined") {
  document.addEventListener(NAV_INVALIDATE, () => {
    if (state === "fresh") state = "stale";
  });
}

/** Top-down location labels for a doc from the primed map: [db] › ancestors. */
export function docParentChain(id: string): string[] {
  const out: string[] = [];
  let cur = owners.get(id);
  const seen = new Set<string>([id]);
  let dbId = cur?.database_id ?? null;
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    const pid = cur.parent_id;
    seen.add(pid);
    out.unshift(titles.get(pid) || "");
    cur = owners.get(pid);
    if (cur?.database_id) dbId = cur.database_id;
  }
  if (dbId) out.unshift(titles.get(dbId) || "");
  return out;
}
