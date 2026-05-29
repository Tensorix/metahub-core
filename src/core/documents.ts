import type { Database } from "bun:sqlite";
import { makeId } from "./ids.ts";
import { emit } from "./crdt.ts";
import { parseBlocks, serializeBlocks, reconcile } from "./blocks.ts";
import { keysBetween } from "./fracdex.ts";

export interface DocumentRow {
  id: string;
  title: string;
  body: string | null;
  database_id: string | null;
  parent_id: string | null;
  created_hlc: string;
}

export type DocumentSummary = Omit<DocumentRow, "body">;

interface BlockRow {
  id: string;
  text: string;
  order_key: string;
}

// ---- block helpers ---------------------------------------------------------

function liveBlocks(db: Database, docId: string): BlockRow[] {
  return db
    .query(
      "SELECT id, text, order_key FROM doc_blocks WHERE doc_id = ? AND __deleted = 0 ORDER BY order_key, id",
    )
    .all(docId) as BlockRow[];
}

function makeBlockId(text: string): string {
  return makeId(text.split("\n", 1)[0] ?? "", "blk");
}

/** Emit a new block's fields; text last so the final body recompute is complete. */
function emitBlock(
  db: Database,
  docId: string,
  fields: { text: string; order_key: string },
): void {
  const id = makeBlockId(fields.text);
  emit(db, "doc_blocks", id, "doc_id", docId);
  emit(db, "doc_blocks", id, "order_key", fields.order_key);
  emit(db, "doc_blocks", id, "text", fields.text);
}

function insertBlocks(
  db: Database,
  docId: string,
  texts: string[],
  after: string | null,
  before: string | null,
): void {
  const keys = keysBetween(after, before, texts.length);
  texts.forEach((text, i) => emitBlock(db, docId, { text, order_key: keys[i]! }));
}

/** Lazily migrate a legacy body-only document into blocks (idempotent). */
function ensureBlocks(db: Database, docId: string): void {
  if (db.query("SELECT 1 AS x FROM doc_blocks WHERE doc_id = ? LIMIT 1").get(docId))
    return;
  const row = db.query("SELECT body FROM documents WHERE id = ?").get(docId) as
    | { body: string | null }
    | null;
  const texts = parseBlocks(row?.body ?? "");
  if (texts.length) insertBlocks(db, docId, texts, null, null);
}

/** Diff a full new body against current blocks; keep unchanged, delete/insert the rest. */
function reconcileBody(db: Database, docId: string, body: string): void {
  const old = liveBlocks(db, docId);
  const plan = reconcile(
    old.map((b) => b.text),
    parseBlocks(body),
  );

  for (const oi of plan.deleted) emit(db, "doc_blocks", old[oi]!.id, "__deleted", 1);

  const { items } = plan;
  let i = 0;
  while (i < items.length) {
    if ("keep" in items[i]!) {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && "insert" in items[j]!) j++;
    const left = i > 0 ? old[(items[i - 1] as { keep: number }).keep]!.order_key : null;
    const right = j < items.length ? old[(items[j] as { keep: number }).keep]!.order_key : null;
    const texts = items.slice(i, j).map((it) => (it as { insert: string }).insert);
    insertBlocks(db, docId, texts, left, right);
    i = j;
  }
}

/** Max HLC over a document's own register and all its blocks — a read/edit token. */
export function documentVersion(db: Database, id: string): string {
  const row = db
    .query(
      `SELECT MAX(hlc) AS h FROM crdt_changes
       WHERE (dataset = 'documents' AND row_id = ?)
          OR (dataset = 'doc_blocks' AND row_id IN (SELECT id FROM doc_blocks WHERE doc_id = ?))`,
    )
    .get(id, id) as { h: string | null };
  return row.h ?? "";
}

// ---- public API ------------------------------------------------------------

export function createDocument(
  db: Database,
  opts: { title: string; body?: string; database_id?: string; parent_id?: string },
): DocumentRow {
  const id = makeId(opts.title, "doc");
  const first = emit(db, "documents", id, "title", opts.title);
  emit(db, "documents", id, "created_hlc", first.hlc);
  if (opts.database_id !== undefined) emit(db, "documents", id, "database_id", opts.database_id);
  if (opts.parent_id !== undefined) emit(db, "documents", id, "parent_id", opts.parent_id);
  if (opts.body !== undefined) {
    const texts = parseBlocks(opts.body);
    if (texts.length) insertBlocks(db, id, texts, null, null);
  }
  return getDocument(db, id)!;
}

export function getDocument(db: Database, id: string): DocumentRow | null {
  return db
    .query(
      "SELECT id, title, body, database_id, parent_id, created_hlc FROM documents WHERE id = ? AND __deleted = 0",
    )
    .get(id) as DocumentRow | null;
}

export function listDocuments(
  db: Database,
  opts: { database_id?: string } = {},
): DocumentSummary[] {
  if (opts.database_id)
    return db
      .query(
        "SELECT id, title, database_id, parent_id, created_hlc FROM documents WHERE database_id = ? AND __deleted = 0 ORDER BY created_hlc",
      )
      .all(opts.database_id) as DocumentSummary[];
  return db
    .query(
      "SELECT id, title, database_id, parent_id, created_hlc FROM documents WHERE __deleted = 0 ORDER BY created_hlc",
    )
    .all() as DocumentSummary[];
}

export function updateDocument(
  db: Database,
  id: string,
  fields: { title?: string; body?: string; database_id?: string; parent_id?: string },
): DocumentRow {
  if (!getDocument(db, id)) throw new Error(`no such document: ${id}`);
  if (fields.title !== undefined) emit(db, "documents", id, "title", fields.title);
  if (fields.database_id !== undefined) emit(db, "documents", id, "database_id", fields.database_id);
  if (fields.parent_id !== undefined) emit(db, "documents", id, "parent_id", fields.parent_id);
  if (fields.body !== undefined) {
    ensureBlocks(db, id);
    reconcileBody(db, id, fields.body);
  }
  return getDocument(db, id)!;
}

export interface EditDocResult {
  id: string;
  changed: boolean;
  replaced: number;
  version: string;
}

/**
 * Anchored find/replace, like the Edit tool. `old` must occur exactly once
 * (or pass `replaceAll`); supplying it is the read-before-edit guarantee — you
 * cannot author it without current content, and drift surfaces as "not found".
 * `ifMatch` is an optional staleness backstop (a version from documentVersion).
 */
export function editDocument(
  db: Database,
  id: string,
  opts: { old: string; new: string; replaceAll?: boolean; ifMatch?: string },
): EditDocResult {
  if (!getDocument(db, id)) throw new Error(`no such document: ${id}`);
  if (opts.ifMatch !== undefined && documentVersion(db, id) !== opts.ifMatch)
    throw new Error(`stale: document changed since ${opts.ifMatch}; re-read first`);
  if (opts.old === "") throw new Error("--old must not be empty");

  ensureBlocks(db, id);
  const blocks = liveBlocks(db, id);
  const body = serializeBlocks(blocks.map((b) => b.text));
  const count = countOccurrences(body, opts.old);
  if (count === 0) throw new Error(`anchor not found: no match for --old`);
  if (count > 1 && !opts.replaceAll)
    throw new Error(
      `${count} matches for --old; add surrounding context or use --replace-all`,
    );

  // Fast path: edit stays within single blocks and introduces no block break.
  if (!opts.old.includes("\n\n")) {
    const affected = blocks.filter((b) => b.text.includes(opts.old));
    const next = affected.map((b) =>
      opts.replaceAll ? b.text.replaceAll(opts.old, opts.new) : b.text.replace(opts.old, opts.new),
    );
    if (next.every((t) => t.length > 0 && !t.includes("\n\n"))) {
      const targets = opts.replaceAll ? affected : affected.slice(0, 1);
      targets.forEach((b, i) => emit(db, "doc_blocks", b.id, "text", next[i]!));
      return { id, changed: true, replaced: opts.replaceAll ? count : 1, version: documentVersion(db, id) };
    }
  }

  // General path: rewrite the body and reconcile (handles spans/splits/merges).
  const newBody = opts.replaceAll
    ? body.replaceAll(opts.old, opts.new)
    : body.replace(opts.old, opts.new);
  reconcileBody(db, id, newBody);
  return { id, changed: newBody !== body, replaced: opts.replaceAll ? count : 1, version: documentVersion(db, id) };
}

export function appendDocument(db: Database, id: string, body: string): EditDocResult {
  if (!getDocument(db, id)) throw new Error(`no such document: ${id}`);
  ensureBlocks(db, id);
  const texts = parseBlocks(body);
  if (texts.length) {
    const blocks = liveBlocks(db, id);
    const last = blocks.length ? blocks[blocks.length - 1]!.order_key : null;
    insertBlocks(db, id, texts, last, null);
  }
  return { id, changed: texts.length > 0, replaced: texts.length, version: documentVersion(db, id) };
}

export function prependDocument(db: Database, id: string, body: string): EditDocResult {
  if (!getDocument(db, id)) throw new Error(`no such document: ${id}`);
  ensureBlocks(db, id);
  const texts = parseBlocks(body);
  if (texts.length) {
    const blocks = liveBlocks(db, id);
    const first = blocks.length ? blocks[0]!.order_key : null;
    insertBlocks(db, id, texts, null, first);
  }
  return { id, changed: texts.length > 0, replaced: texts.length, version: documentVersion(db, id) };
}

export function deleteDocument(db: Database, id: string): boolean {
  if (!getDocument(db, id)) return false;
  emit(db, "documents", id, "__deleted", 1);
  return true;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
