import type { Database } from "bun:sqlite";
import { newId } from "./ids.ts";
import { emit, grouped } from "./crdt.ts";
import { parseDocBlocks, serializeDocBlocks, reconcile, type DocBlock } from "./blocks.ts";
import { keyBetween, keysBetween } from "./fracdex.ts";
import { MhError } from "./errors.ts";

export interface DocumentRow {
  id: string;
  title: string;
  body: string | null;
  database_id: string | null;
  parent_id: string | null;
  created_hlc: string;
  order_key: string | null;
}

export type DocumentSummary = Omit<DocumentRow, "body">;

interface BlockRow {
  id: string;
  text: string;
  order_key: string;
  blank_after: number;
}

// ---- block helpers ---------------------------------------------------------

function liveBlocks(db: Database, docId: string): BlockRow[] {
  return db
    .query(
      "SELECT id, text, order_key, blank_after FROM doc_blocks WHERE doc_id = ? AND __deleted = 0 ORDER BY order_key, id",
    )
    .all(docId) as BlockRow[];
}

function makeBlockId(text: string): string {
  return newId("blk", text.split("\n", 1)[0] ?? "");
}

/** Emit a new block's fields; text last so the final body recompute is complete.
 *  blank_after is only emitted when non-zero (0 is the column default). */
function emitBlock(
  db: Database,
  docId: string,
  fields: { text: string; order_key: string; blankAfter: number },
): void {
  const id = makeBlockId(fields.text);
  emit(db, "doc_blocks", id, "doc_id", docId);
  emit(db, "doc_blocks", id, "order_key", fields.order_key);
  if (fields.blankAfter) emit(db, "doc_blocks", id, "blank_after", fields.blankAfter);
  emit(db, "doc_blocks", id, "text", fields.text);
}

function insertBlocks(
  db: Database,
  docId: string,
  blocks: readonly DocBlock[],
  after: string | null,
  before: string | null,
): void {
  const keys = keysBetween(after, before, blocks.length);
  blocks.forEach((b, i) =>
    emitBlock(db, docId, { text: b.text, order_key: keys[i]!, blankAfter: b.blankAfter }),
  );
}

/** Lazily migrate a legacy body-only document into blocks (idempotent). */
function ensureBlocks(db: Database, docId: string): void {
  if (db.query("SELECT 1 AS x FROM doc_blocks WHERE doc_id = ? LIMIT 1").get(docId))
    return;
  const row = db.query("SELECT body FROM documents WHERE id = ?").get(docId) as
    | { body: string | null }
    | null;
  const blocks = parseDocBlocks(row?.body ?? "");
  if (blocks.length) insertBlocks(db, docId, blocks, null, null);
}

/** Diff a full new body against current blocks; keep unchanged, delete/insert the rest. */
function reconcileBody(db: Database, docId: string, body: string): void {
  const old = liveBlocks(db, docId);
  const next = parseDocBlocks(body);
  const plan = reconcile(
    old.map((b) => b.text),
    next.map((b) => b.text),
  );

  for (const oi of plan.deleted) emit(db, "doc_blocks", old[oi]!.id, "__deleted", 1);

  const { items } = plan;
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if ("keep" in it) {
      // Text unchanged: only the surrounding blank-line count may have shifted.
      const oldB = old[it.keep]!;
      const want = next[i]!.blankAfter;
      if ((oldB.blank_after ?? 0) !== want) emit(db, "doc_blocks", oldB.id, "blank_after", want);
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && "insert" in items[j]!) j++;
    const left = i > 0 ? old[(items[i - 1] as { keep: number }).keep]!.order_key : null;
    const right = j < items.length ? old[(items[j] as { keep: number }).keep]!.order_key : null;
    insertBlocks(db, docId, next.slice(i, j), left, right);
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

export const createDocument = grouped(function createDocument(
  db: Database,
  opts: { title: string; body?: string; database_id?: string; parent_id?: string },
): DocumentRow {
  const id = newId("doc", opts.title);
  const first = emit(db, "documents", id, "title", opts.title);
  emit(db, "documents", id, "created_hlc", first.hlc);
  if (opts.database_id !== undefined) emit(db, "documents", id, "database_id", opts.database_id);
  if (opts.parent_id !== undefined) emit(db, "documents", id, "parent_id", opts.parent_id);
  placeInSiblings(db, id, opts.parent_id ?? null); // append to the end of its sibling group
  if (opts.body !== undefined) {
    const blocks = parseDocBlocks(opts.body);
    if (blocks.length) insertBlocks(db, id, blocks, null, null);
  }
  return getDocument(db, id)!;
});

export function getDocument(db: Database, id: string): DocumentRow | null {
  return db
    .query(
      "SELECT id, title, body, database_id, parent_id, created_hlc, order_key FROM documents WHERE id = ? AND __deleted = 0",
    )
    .get(id) as DocumentRow | null;
}

/** Display order among siblings: explicit order_key first, NULLs fall back to
 *  creation time so an un-backfilled tree still renders in its historical order. */
const ORDER_BY = "ORDER BY order_key IS NULL, order_key, created_hlc, id";

export function listDocuments(
  db: Database,
  opts: { database_id?: string; parent_id?: string } = {},
): DocumentSummary[] {
  const cols =
    "SELECT id, title, database_id, parent_id, created_hlc, order_key FROM documents WHERE __deleted = 0";
  if (opts.parent_id !== undefined)
    return db
      .query(`${cols} AND parent_id = ? ${ORDER_BY}`)
      .all(opts.parent_id) as DocumentSummary[];
  if (opts.database_id)
    return db
      .query(`${cols} AND database_id = ? ${ORDER_BY}`)
      .all(opts.database_id) as DocumentSummary[];
  return db.query(`${cols} ${ORDER_BY}`).all() as DocumentSummary[];
}

// ---- sibling ordering (fractional index scoped per parent_id) --------------

interface SiblingRow {
  id: string;
  order_key: string | null;
}

/** WHERE fragment + args selecting siblings under `parentId` (null = top level). */
function siblingWhere(parentId: string | null): { clause: string; args: string[] } {
  return parentId === null
    ? { clause: "parent_id IS NULL", args: [] }
    : { clause: "parent_id = ?", args: [parentId] };
}

function canEmitOrderKeys(db: Database): boolean {
  return tableExists(db, "meta") && tableExists(db, "crdt_changes");
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

/** Greatest order_key among siblings (optionally ignoring one row being placed). */
function lastSiblingOrderKey(
  db: Database,
  parentId: string | null,
  excludeId?: string,
): string | null {
  const w = siblingWhere(parentId);
  const exclude = excludeId ? " AND id <> ?" : "";
  const row = db
    .query(
      `SELECT order_key FROM documents WHERE ${w.clause}${exclude}
       AND __deleted = 0 AND order_key IS NOT NULL
       ORDER BY order_key DESC, id DESC LIMIT 1`,
    )
    .get(...w.args, ...(excludeId ? [excludeId] : [])) as { order_key: string | null } | null;
  return row?.order_key ?? null;
}

function orderedSiblings(db: Database, parentId: string | null): SiblingRow[] {
  const w = siblingWhere(parentId);
  return db
    .query(`SELECT id, order_key FROM documents WHERE ${w.clause} AND __deleted = 0 ${ORDER_BY}`)
    .all(...w.args) as SiblingRow[];
}

/** Re-space every sibling's key evenly — escape hatch when fractional keys collide. */
function rebalanceSiblings(db: Database, parentId: string | null): void {
  const rows = orderedSiblings(db, parentId);
  const keys = keysBetween(null, null, rows.length);
  rows.forEach((row, i) => {
    if (row.order_key !== keys[i]) emit(db, "documents", row.id, "order_key", keys[i]!);
  });
}

/** Assign keys to siblings that still lack one, appending in creation order. */
function backfillSiblings(db: Database, parentId: string | null): void {
  const emitChange = canEmitOrderKeys(db);
  const w = siblingWhere(parentId);
  const missing = db
    .query(
      `SELECT id FROM documents WHERE ${w.clause} AND __deleted = 0 AND order_key IS NULL
       ORDER BY created_hlc, id`,
    )
    .all(...w.args) as { id: string }[];
  if (!missing.length) return;
  const keys = keysBetween(lastSiblingOrderKey(db, parentId), null, missing.length);
  missing.forEach((row, i) => {
    if (emitChange) emit(db, "documents", row.id, "order_key", keys[i]!);
    else db.query("UPDATE documents SET order_key = ? WHERE id = ?").run(keys[i]!, row.id);
  });
}

/** Backfill order_key for every parent group that has un-keyed live documents. */
export const backfillDocumentOrderKeys = grouped(function backfillDocumentOrderKeys(
  db: Database,
): void {
  const parents = db
    .query("SELECT DISTINCT parent_id FROM documents WHERE __deleted = 0 AND order_key IS NULL")
    .all() as { parent_id: string | null }[];
  for (const p of parents) backfillSiblings(db, p.parent_id);
});

/**
 * Place `id` under `parentId` at the given position — the single point where a
 * document's parent_id and order_key are kept consistent (reparent always
 * implies a new sibling scope). No `anchor` appends to the end of the group.
 */
function placeInSiblings(
  db: Database,
  id: string,
  parentId: string | null,
  anchor?: { targetId: string; where: "before" | "after" },
): void {
  // Walk the prospective ancestor chain; reaching `id` would form a cycle and
  // make the tree unrenderable. Guarded here so every caller is protected.
  let cur: string | null | undefined = parentId;
  while (cur) {
    if (cur === id) throw new MhError("invalid_input", `cannot set parent_id: would create a cycle (${id})`);
    cur = getDocument(db, cur)?.parent_id ?? null;
  }

  const current = getDocument(db, id);
  if (current && (current.parent_id ?? null) !== parentId)
    emit(db, "documents", id, "parent_id", parentId);

  let key: string;
  if (!anchor) {
    key = keyBetween(lastSiblingOrderKey(db, parentId, id), null);
  } else {
    backfillSiblings(db, parentId); // ensure neighbors carry comparable keys
    const neighbors = (): [string | null, string | null] => {
      const rows = orderedSiblings(db, parentId).filter((r) => r.id !== id);
      const to = rows.findIndex((r) => r.id === anchor.targetId);
      if (to < 0) throw new MhError("not_found", `no such target document: ${anchor.targetId}`);
      return anchor.where === "before"
        ? [rows[to - 1]?.order_key ?? null, rows[to]!.order_key]
        : [rows[to]!.order_key, rows[to + 1]?.order_key ?? null];
    };
    let [left, right] = neighbors();
    if (left !== null && right !== null && left >= right) {
      rebalanceSiblings(db, parentId);
      [left, right] = neighbors();
    }
    key = keyBetween(left, right);
  }
  emit(db, "documents", id, "order_key", key);
}

/**
 * Move a document next to / into another, atomically updating both its parent
 * and its order_key. `into` nests it as the last child of `targetId`;
 * `before`/`after` re-orders (and reparents if needed) among the target's siblings.
 */
export const moveDocument = grouped(function moveDocument(
  db: Database,
  id: string,
  targetId: string,
  where: "before" | "after" | "into",
): DocumentRow {
  const src = getDocument(db, id);
  if (!src) throw new MhError("not_found", `no such document: ${id}`);
  if (id === targetId) return src;
  const target = getDocument(db, targetId);
  if (!target) throw new MhError("not_found", `no such target document: ${targetId}`);

  if (where === "into") placeInSiblings(db, id, targetId);
  else placeInSiblings(db, id, target.parent_id, { targetId, where });
  return getDocument(db, id)!;
});

/**
 * Copy a document — title, every block (verbatim, with fresh block ids so the
 * copy edits independently) and its `database_id`/`parent_id`. The copy lands
 * right after its source in the same sibling scope. Blocks are cloned at the
 * block level (not via a markdown round-trip) so empty list items / blank-line
 * runs survive losslessly. `title`/`parentId` override the defaults; the locale
 * "copy" suffix is the caller's job. `created_hlc` is the copy's own birth time.
 */
export const duplicateDocument = grouped(function duplicateDocument(
  db: Database,
  id: string,
  opts: { title?: string; parentId?: string | null } = {},
): DocumentRow {
  const src = getDocument(db, id);
  if (!src) throw new MhError("not_found", `no such document: ${id}`);
  ensureBlocks(db, id);
  const blocks = liveBlocks(db, id);
  const parentId = opts.parentId !== undefined ? opts.parentId : src.parent_id;
  const dup = createDocument(db, {
    title: opts.title ?? src.title,
    database_id: src.database_id ?? undefined,
    parent_id: parentId ?? undefined,
  });
  if (blocks.length)
    insertBlocks(
      db,
      dup.id,
      blocks.map((b) => ({ text: b.text, blankAfter: b.blank_after })),
      null,
      null,
    );
  // Sit the copy right after its source when they share a sibling scope.
  if (parentId === src.parent_id) moveDocument(db, dup.id, src.id, "after");
  return getDocument(db, dup.id)!;
});

export const updateDocument = grouped(function updateDocument(
  db: Database,
  id: string,
  fields: { title?: string; body?: string; database_id?: string; parent_id?: string | null },
  opts: { ifMatch?: string } = {},
): DocumentRow {
  if (!getDocument(db, id)) throw new MhError("not_found", `no such document: ${id}`);
  // Same staleness backstop as editDocument: a version from documentVersion()
  // rejects the write if the doc changed since the caller read it.
  if (opts.ifMatch !== undefined && documentVersion(db, id) !== opts.ifMatch)
    throw new MhError("stale", `stale: document changed since ${opts.ifMatch}; re-read first`);
  if (fields.title !== undefined) emit(db, "documents", id, "title", fields.title);
  if (fields.database_id !== undefined) emit(db, "documents", id, "database_id", fields.database_id);
  if (fields.parent_id !== undefined) {
    // Reparenting moves the document into a new sibling scope, so its order_key
    // must be reassigned too — placeInSiblings keeps both consistent (and guards
    // against cycles) for every caller: CLI, WebUI, sync. Only act on a real
    // change so a no-op PATCH doesn't silently jump the document to the end.
    const next = fields.parent_id ?? null;
    if ((getDocument(db, id)!.parent_id ?? null) !== next) placeInSiblings(db, id, next);
  }
  if (fields.body !== undefined) {
    ensureBlocks(db, id);
    reconcileBody(db, id, fields.body);
  }
  return getDocument(db, id)!;
});

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
export const editDocument = grouped(function editDocument(
  db: Database,
  id: string,
  opts: { old: string; new: string; replaceAll?: boolean; ifMatch?: string },
): EditDocResult {
  if (!getDocument(db, id)) throw new MhError("not_found", `no such document: ${id}`);
  if (opts.ifMatch !== undefined && documentVersion(db, id) !== opts.ifMatch)
    throw new MhError("stale", `stale: document changed since ${opts.ifMatch}; re-read first`);
  if (opts.old === "") throw new MhError("invalid_input", "--old must not be empty");

  ensureBlocks(db, id);
  const blocks = liveBlocks(db, id);
  const body = serializeDocBlocks(blocks.map((b) => ({ text: b.text, blankAfter: b.blank_after })));
  const count = countOccurrences(body, opts.old);
  if (count === 0) throw new MhError("invalid_input", `anchor not found: no match for --old`);
  if (count > 1 && !opts.replaceAll)
    throw new MhError(
      "ambiguous",
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
});

export const appendDocument = grouped(function appendDocument(
  db: Database,
  id: string,
  body: string,
): EditDocResult {
  if (!getDocument(db, id)) throw new MhError("not_found", `no such document: ${id}`);
  ensureBlocks(db, id);
  const next = parseDocBlocks(body);
  if (next.length) {
    const blocks = liveBlocks(db, id);
    const last = blocks.length ? blocks[blocks.length - 1]!.order_key : null;
    insertBlocks(db, id, next, last, null);
  }
  return { id, changed: next.length > 0, replaced: next.length, version: documentVersion(db, id) };
});

export const prependDocument = grouped(function prependDocument(
  db: Database,
  id: string,
  body: string,
): EditDocResult {
  if (!getDocument(db, id)) throw new MhError("not_found", `no such document: ${id}`);
  ensureBlocks(db, id);
  const next = parseDocBlocks(body);
  if (next.length) {
    const blocks = liveBlocks(db, id);
    const first = blocks.length ? blocks[0]!.order_key : null;
    insertBlocks(db, id, next, null, first);
  }
  return { id, changed: next.length > 0, replaced: next.length, version: documentVersion(db, id) };
});

export const deleteDocument = grouped(function deleteDocument(db: Database, id: string): boolean {
  if (!getDocument(db, id)) return false;
  emit(db, "documents", id, "__deleted", 1);
  // Cascade off the tombstone, mirroring repairHub: the doc's blocks are derived
  // content -> tombstone them; live child documents survive as roots -> unparent.
  for (const b of liveChildIds(db, "doc_blocks", "doc_id", id))
    emit(db, "doc_blocks", b, "__deleted", 1);
  for (const c of liveChildIds(db, "documents", "parent_id", id))
    emit(db, "documents", c, "parent_id", null);
  return true;
});

/** Ids of live rows in `table` whose `col` references `parentId`. */
function liveChildIds(db: Database, table: string, col: string, parentId: string): string[] {
  return (
    db
      .query(`SELECT id FROM ${table} WHERE ${col} = ? AND __deleted = 0`)
      .all(parentId) as { id: string }[]
  ).map((r) => r.id);
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
