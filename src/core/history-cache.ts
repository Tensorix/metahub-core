import type { RawChange, DocRevision, DocumentVersionState } from "./history.ts";

export interface DocHistoryEntry {
  changes: RawChange[];
  blockIds: Set<string>;
  revisions: DocRevision[] | null;
  states: Map<string, DocumentVersionState>;
}

interface Cache {
  docs: Map<string, DocHistoryEntry>;
  blockToDoc: Map<string, string>;
}

const caches = new WeakMap<object, Cache>();
const MAX_DOCS = 16;
const MAX_STATES = 64;

function cacheFor(db: object): Cache {
  let c = caches.get(db);
  if (!c) {
    c = { docs: new Map(), blockToDoc: new Map() };
    caches.set(db, c);
  }
  return c;
}

function dropDoc(c: Cache, docId: string): void {
  const e = c.docs.get(docId);
  if (!e) return;
  c.docs.delete(docId);
  for (const b of e.blockIds) if (c.blockToDoc.get(b) === docId) c.blockToDoc.delete(b);
}

export function getDocHistory(db: object, docId: string): DocHistoryEntry | undefined {
  const c = caches.get(db);
  const e = c?.docs.get(docId);
  if (!c || !e) return undefined;
  c.docs.delete(docId);
  c.docs.set(docId, e);
  return e;
}

export function setDocHistory(
  db: object,
  docId: string,
  changes: RawChange[],
  blockIds: Iterable<string>,
): DocHistoryEntry {
  const c = cacheFor(db);
  dropDoc(c, docId);
  const entry: DocHistoryEntry = { changes, blockIds: new Set(blockIds), revisions: null, states: new Map() };
  c.docs.set(docId, entry);
  for (const b of entry.blockIds) c.blockToDoc.set(b, docId);
  while (c.docs.size > MAX_DOCS) dropDoc(c, c.docs.keys().next().value!);
  return entry;
}

export function rememberDocState(entry: DocHistoryEntry, at: string, state: DocumentVersionState): void {
  if (entry.states.size >= MAX_STATES) entry.states.delete(entry.states.keys().next().value!);
  entry.states.set(at, state);
}

export function noteChange(db: object, dataset: string, rowId: string, col: string, value: string | null): void {
  const c = caches.get(db);
  if (!c) return;
  if (dataset === "documents") {
    dropDoc(c, rowId);
    return;
  }
  if (dataset !== "doc_blocks") return;
  const owner = c.blockToDoc.get(rowId);
  if (owner) dropDoc(c, owner);
  if (col === "doc_id" && value) {
    try {
      const target: unknown = JSON.parse(value);
      if (typeof target === "string") dropDoc(c, target);
    } catch {}
  }
}

export function invalidateHistory(db: object): void {
  caches.delete(db);
}
