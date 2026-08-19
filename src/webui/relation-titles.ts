// Synchronous record-title lookup for relation chips, keyed by target database.
//
// Chips render synchronously all over the grid/board/peek, so they need an
// in-memory recId → title map per target db (same idiom as doc-titles.ts, but
// bucketed: each relation column points at one target db and a dead target
// must not poison the others). Titles follow core's name-resolution rule —
// the FIRST TEXT property by position (resolve.ts titlePropId) — so a chip
// shows exactly the string that typing it back would resolve to. (The peek and
// board headers use props[0] of any type; that divergence is deliberate here.)
//
// Staleness: SYNCED_EVENT covers remote changes on the replica path;
// REC_INVALIDATE covers same-tab record mutations in window (HTTP) mode, where
// no sync events exist. Stale buckets keep serving old titles while a refresh
// runs (no flicker); subscribers fire only when a title actually changed.
// Failed loads park the bucket in `error` (chips fall back to ids) instead of
// retrying per render — a deleted target db must not become a request storm.

import { api, REC_INVALIDATE, type Prop, type Rec } from "./api";
import { SYNCED_EVENT } from "./data/replica.ts";

/** A record's display title: value of the first text property by position —
 *  core's titlePropId rule. Null when the db has no text property. */
export function recordTitle(props: Prop[], rec: Rec): string | null {
  const tp = props.find((p) => p.type === "text");
  if (!tp) return null;
  const v = rec.cells[tp.id];
  return v == null ? "" : String(v);
}

interface Bucket {
  state: "loading" | "fresh" | "stale" | "error";
  titles: Map<string, string | null>;
  /** The target db's title (first text) property id; null when it has none. */
  titleProp: string | null;
  inflight: Promise<void> | null;
}

const buckets = new Map<string, Bucket>();
const listeners = new Set<() => void>();

/** Notify on any title change; returns the unsubscribe. */
export function onRelationTitleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Sync lookup: the record's title ("" is legal, null = target db has no text
 *  property or the id is dangling/failed, undefined = first load in flight —
 *  a refresh is kicked and onRelationTitleChange fires when it lands). */
export function relationTitle(dbId: string | undefined, recId: string): string | null | undefined {
  if (!dbId) return null; // misconfigured relation — nothing to look up
  const b = buckets.get(dbId);
  if (!b) {
    void refresh(dbId);
    return undefined;
  }
  if (b.state === "loading") return b.titles.size ? (b.titles.get(recId) ?? null) : undefined;
  if (b.state === "stale") void refresh(dbId);
  if (b.state === "error") return null;
  return b.titles.get(recId) ?? null;
}

/** The full title list of one target db for the record picker (insertion =
 *  record order). Kicks a load when cold; empty until it lands. */
export function relationTitleList(dbId: string): { id: string; title: string | null }[] {
  const b = buckets.get(dbId);
  if (!b) {
    void refresh(dbId);
    return [];
  }
  if (b.state === "stale") void refresh(dbId);
  return [...b.titles].map(([id, title]) => ({ id, title }));
}

/** The bucket's load state (kicks a load when cold) — lets the picker tell
 *  "loading" and "unreachable target" apart from a genuinely empty db. */
export function relationTitleState(dbId: string): Bucket["state"] {
  const b = buckets.get(dbId);
  if (!b) {
    void refresh(dbId);
    return "loading";
  }
  return b.state;
}

/** The target db's title property id — where the picker's "创建" writes the new
 *  record's title. Null while loading or when the db has no text property. */
export function relationTitleProp(dbId: string): string | null {
  return buckets.get(dbId)?.titleProp ?? null;
}

/** Seed one known title (e.g. a record the picker just created) so its chip
 *  never flashes the raw id while the bucket refreshes. */
export function primeRelationTitle(dbId: string, recId: string, title: string | null): void {
  const b = buckets.get(dbId);
  if (!b) return; // next lookup loads the real thing anyway
  b.titles.set(recId, title);
  if (b.state === "fresh") b.state = "stale";
  for (const fn of listeners) fn();
}

async function refresh(dbId: string): Promise<void> {
  let b = buckets.get(dbId);
  if (b?.inflight) return b.inflight; // per-db single flight
  if (!b) {
    b = { state: "loading", titles: new Map(), titleProp: null, inflight: null };
    buckets.set(dbId, b);
  }
  b.inflight = (async () => {
    try {
      const [props, recs] = await Promise.all([api.listProperties(dbId), api.listRecords(dbId)]);
      b.titleProp = props.find((p) => p.type === "text")?.id ?? null;
      const next = new Map<string, string | null>();
      for (const r of recs) next.set(r.id, recordTitle(props, r));
      const changed =
        b.state !== "fresh" ||
        next.size !== b.titles.size ||
        [...next].some(([id, t]) => b.titles.get(id) !== t);
      b.titles = next;
      b.state = "fresh";
      if (changed) for (const fn of listeners) fn();
    } catch {
      // Deleted/unreachable target db: park until the next invalidation
      // instead of retrying on every chip render.
      b.state = "error";
      if (b.titles.size) {
        b.titles = new Map();
        for (const fn of listeners) fn();
      }
    } finally {
      b.inflight = null;
    }
  })();
  return b.inflight;
}

function markAllStale(): void {
  for (const b of buckets.values()) {
    // error buckets get another chance; fresh ones re-fetch on next lookup
    if (b.state === "fresh" || b.state === "error") b.state = "stale";
  }
}

if (typeof document !== "undefined") {
  document.addEventListener(REC_INVALIDATE, markAllStale);
  document.addEventListener(SYNCED_EVENT, (e) => {
    // The synced detail has no rowId→db mapping, so staleness is all-or-nothing.
    const d = (e as CustomEvent).detail as { datasets?: string[] } | undefined;
    if (!d?.datasets || d.datasets.some((ds) => ds === "records" || ds === "properties"))
      markAllStale();
  });
}
