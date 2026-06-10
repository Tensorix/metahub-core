import type { Database } from "bun:sqlite";
import { emit } from "./crdt.ts";
import { serializeDocBlocks } from "./blocks.ts";
import { getDocument, updateDocument, documentVersion } from "./documents.ts";
import { listProperties } from "./properties.ts";
import { MhError } from "./errors.ts";

// Read-side history over the CRDT oplog. The oplog (crdt_changes) is append-only
// and never compacted, so the state of any register at a cutoff HLC `at` is the
// value with the greatest hlc <= at — the same last-write-wins rule materialize()
// applies at the head. Revert is a *forward* write: reconstruct the old state,
// diff against the present, and emit the differences as new changes. The oplog
// itself is never edited (it is the sync source of truth), so reverts replicate
// and converge like any other edit.

/** Changes from the same node closer together than this are one revision: a
 *  single save emits a burst of field writes with near-identical timestamps. */
const REVISION_GAP_MS = 1500;

/** Physical wall-clock milliseconds encoded in an HLC (first 15 digits). */
function hlcMillis(hlc: string): number {
  return Number(hlc.slice(0, 15));
}

function hlcIso(hlc: string): string {
  return new Date(hlcMillis(hlc)).toISOString();
}

interface RawChange {
  hlc: string;
  node_id: string;
  dataset: string;
  row_id: string;
  col: string;
  value: string | null;
}

/** Group an HLC-ordered change stream into revisions: a new group starts when
 *  the author changes or the wall-clock gap exceeds REVISION_GAP_MS. Clustering
 *  depends only on oplog content, so every synced node renders the same list. */
function clusterRevisions(changes: RawChange[]): RawChange[][] {
  const groups: RawChange[][] = [];
  let cur: RawChange[] = [];
  for (const c of changes) {
    const prev = cur[cur.length - 1];
    if (prev && (prev.node_id !== c.node_id || hlcMillis(c.hlc) - hlcMillis(prev.hlc) > REVISION_GAP_MS)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** True when a JSON-encoded oplog value is a truthy flag (e.g. __deleted = 1). */
function flagSet(value: string | null): boolean {
  return value !== null && value !== "0" && value !== "false" && value !== "null";
}

/** Latest value per register (col) among `changes` with hlc <= at.
 *  A `null` value column means the register was cleared (json_remove). */
function registersAt(
  changes: RawChange[],
  at: string,
): Map<string, { value: string | null; hlc: string }> {
  const out = new Map<string, { value: string | null; hlc: string }>();
  for (const c of changes) {
    if (c.hlc > at) continue;
    const cur = out.get(c.col);
    if (!cur || c.hlc > cur.hlc) out.set(c.col, { value: c.value, hlc: c.hlc });
  }
  return out;
}

/** All oplog changes for one row of a dataset, in HLC order. */
function rowChanges(db: Database, dataset: string, rowId: string): RawChange[] {
  return db
    .query(
      "SELECT hlc, node_id, dataset, row_id, col, value FROM crdt_changes WHERE dataset = ? AND row_id = ? ORDER BY hlc",
    )
    .all(dataset, rowId) as RawChange[];
}

// ---- documents ---------------------------------------------------------------

/** Ids of every block that was ever assigned to this document. Whether a block
 *  counts at a given cutoff is decided later from its registers at that cutoff. */
function everBlockIds(db: Database, docId: string): string[] {
  return (
    db
      .query(
        "SELECT DISTINCT row_id FROM crdt_changes WHERE dataset = 'doc_blocks' AND col = 'doc_id' AND value = ?",
      )
      .all(JSON.stringify(docId)) as { row_id: string }[]
  ).map((r) => r.row_id);
}

/** Doc register changes + changes of every block ever attached, in HLC order. */
function docChanges(db: Database, docId: string): RawChange[] {
  const blocks = everBlockIds(db, docId);
  const placeholders = blocks.map(() => "?").join(",");
  const blockClause = blocks.length
    ? ` OR (dataset = 'doc_blocks' AND row_id IN (${placeholders}))`
    : "";
  return db
    .query(
      `SELECT hlc, node_id, dataset, row_id, col, value FROM crdt_changes
       WHERE (dataset = 'documents' AND row_id = ?)${blockClause}
       ORDER BY hlc`,
    )
    .all(docId, ...blocks) as RawChange[];
}

export interface DocRevision {
  /** Version token (max HLC of the revision) — pass to documentAtVersion/revertDocument. */
  version: string;
  /** Wall-clock time derived from the version HLC (ISO 8601). */
  at: string;
  node_id: string;
  changes: number;
  created: boolean;
  deleted: boolean;
  title_changed: boolean;
  blocks_changed: number;
  blocks_deleted: number;
}

/** A document's edit history, newest first, clustered into save-sized revisions. */
export function listDocumentRevisions(db: Database, id: string): DocRevision[] {
  const changes = docChanges(db, id);
  if (!changes.length) throw new MhError("not_found", `no such document: ${id}`);
  return clusterRevisions(changes)
    .map((group) => {
      const changedBlocks = new Set<string>();
      const deletedBlocks = new Set<string>();
      let created = false;
      let deleted = false;
      let titleChanged = false;
      for (const c of group) {
        if (c.dataset === "documents") {
          if (c.col === "created_hlc") created = true;
          else if (c.col === "title") titleChanged = true;
          else if (c.col === "__deleted") deleted = flagSet(c.value);
        } else if (c.col === "__deleted" && flagSet(c.value)) {
          deletedBlocks.add(c.row_id);
        } else if (c.col === "text") {
          changedBlocks.add(c.row_id);
        }
      }
      const last = group[group.length - 1]!;
      return {
        version: last.hlc,
        at: hlcIso(last.hlc),
        node_id: last.node_id,
        changes: group.length,
        created,
        deleted,
        title_changed: titleChanged,
        blocks_changed: changedBlocks.size,
        blocks_deleted: deletedBlocks.size,
      };
    })
    .reverse();
}

export interface DocumentVersionState {
  id: string;
  title: string;
  body: string;
  deleted: boolean;
  /** Exact version (max HLC <= the requested cutoff) this state corresponds to. */
  version: string;
}

/** Reconstruct a document as of version cutoff `at` (state at hlc <= at). */
export function documentAtVersion(db: Database, id: string, at: string): DocumentVersionState {
  if (!at) throw new MhError("invalid_input", "missing version cutoff");
  const changes = docChanges(db, id).filter((c) => c.hlc <= at);
  if (!changes.length)
    throw new MhError("not_found", `no version of document ${id} at or before ${at}`);

  const docRegs = registersAt(changes.filter((c) => c.dataset === "documents"), at);
  const parse = (col: string): unknown => {
    const r = docRegs.get(col);
    return r?.value == null ? undefined : JSON.parse(r.value);
  };

  // Per-block registers at the cutoff; a block counts only if it points at this
  // document, is not tombstoned, and has text — mirroring recomputeDocBody().
  const byBlock = new Map<string, RawChange[]>();
  for (const c of changes) {
    if (c.dataset !== "doc_blocks") continue;
    (byBlock.get(c.row_id) ?? byBlock.set(c.row_id, []).get(c.row_id)!).push(c);
  }
  const blocks: { id: string; text: string; order_key: string | null; blankAfter: number }[] = [];
  for (const [blockId, blockChanges] of byBlock) {
    const regs = registersAt(blockChanges, at);
    const reg = (col: string): unknown => {
      const r = regs.get(col);
      return r?.value == null ? undefined : JSON.parse(r.value);
    };
    if (reg("doc_id") !== id) continue;
    if (regs.get("__deleted") && flagSet(regs.get("__deleted")!.value)) continue;
    const text = reg("text");
    if (typeof text !== "string" || !text) continue;
    blocks.push({
      id: blockId,
      text,
      order_key: (reg("order_key") as string | undefined) ?? null,
      blankAfter: (reg("blank_after") as number | undefined) ?? 0,
    });
  }
  blocks.sort((a, b) => {
    if (a.order_key !== b.order_key) {
      if (a.order_key === null) return -1; // NULL sorts first, like the SQL ORDER BY
      if (b.order_key === null) return 1;
      return a.order_key < b.order_key ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  // Pre-block-model documents kept their body in the documents.body register;
  // it stays authoritative until the first block exists (cf. isBlockManaged).
  const body = byBlock.size
    ? serializeDocBlocks(blocks)
    : ((parse("body") as string | undefined) ?? "");

  return {
    id,
    title: (parse("title") as string | undefined) ?? "",
    body,
    deleted: docRegs.get("__deleted") ? flagSet(docRegs.get("__deleted")!.value) : false,
    version: changes[changes.length - 1]!.hlc,
  };
}

export interface RevertDocResult {
  id: string;
  changed: boolean;
  /** The version token the document was restored to. */
  restored: string;
  /** The document's version after the revert (a new head — revert is a forward write). */
  version: string;
}

/** Restore a document's title/body to a past version, as a new forward edit
 *  (reuses updateDocument's block reconcile, so unchanged blocks keep identity). */
export function revertDocument(
  db: Database,
  id: string,
  to: string,
  opts: { ifMatch?: string } = {},
): RevertDocResult {
  const cur = getDocument(db, id);
  if (!cur) throw new MhError("not_found", `no such document: ${id}`);
  if (opts.ifMatch !== undefined && documentVersion(db, id) !== opts.ifMatch)
    throw new MhError("stale", `stale: document changed since ${opts.ifMatch}; re-read first`);

  const past = documentAtVersion(db, id, to);
  if (past.deleted)
    throw new MhError("invalid_input", "target version is a deleted state; use doc delete instead");

  const fields: { title?: string; body?: string } = {};
  if (past.title !== cur.title) fields.title = past.title;
  if (past.body !== (cur.body ?? "")) fields.body = past.body;
  if (Object.keys(fields).length) updateDocument(db, id, fields);

  return {
    id,
    changed: Object.keys(fields).length > 0,
    restored: past.version,
    version: documentVersion(db, id),
  };
}

// ---- records -------------------------------------------------------------------

/** records-dataset meta columns; every other col is a property cell. */
const RECORD_META = new Set(["database_id", "created_hlc", "order_key", "__deleted"]);

export interface RecordRevision {
  version: string;
  at: string;
  node_id: string;
  changes: number;
  created: boolean;
  deleted: boolean;
  /** Property ids of the cells written in this revision. */
  fields: string[];
  moved: boolean;
}

/** A record's edit history, newest first, clustered into save-sized revisions. */
export function listRecordRevisions(db: Database, id: string): RecordRevision[] {
  const changes = rowChanges(db, "records", id);
  if (!changes.length) throw new MhError("not_found", `no such record: ${id}`);
  return clusterRevisions(changes)
    .map((group) => {
      const fields = new Set<string>();
      let created = false;
      let deleted = false;
      let moved = false;
      for (const c of group) {
        if (c.col === "created_hlc") created = true;
        else if (c.col === "__deleted") deleted = flagSet(c.value);
        else if (c.col === "order_key") moved = true;
        else if (!RECORD_META.has(c.col)) fields.add(c.col);
      }
      const last = group[group.length - 1]!;
      return {
        version: last.hlc,
        at: hlcIso(last.hlc),
        node_id: last.node_id,
        changes: group.length,
        created,
        deleted,
        fields: [...fields],
        moved,
      };
    })
    .reverse();
}

export interface RecordVersionState {
  id: string;
  database_id: string | null;
  deleted: boolean;
  /** Cells present at that version, keyed by property id (raw, no name mapping). */
  data: Record<string, unknown>;
  version: string;
}

/** Reconstruct a record as of version cutoff `at` (state at hlc <= at). */
export function recordAtVersion(db: Database, id: string, at: string): RecordVersionState {
  if (!at) throw new MhError("invalid_input", "missing version cutoff");
  const changes = rowChanges(db, "records", id).filter((c) => c.hlc <= at);
  if (!changes.length)
    throw new MhError("not_found", `no version of record ${id} at or before ${at}`);

  const regs = registersAt(changes, at);
  const data: Record<string, unknown> = {};
  for (const [col, reg] of regs) {
    if (RECORD_META.has(col)) continue;
    if (reg.value === null) continue; // cleared cell (json_remove)
    data[col] = JSON.parse(reg.value);
  }
  const dbReg = regs.get("database_id");
  return {
    id,
    database_id: dbReg?.value == null ? null : (JSON.parse(dbReg.value) as string),
    deleted: regs.get("__deleted") ? flagSet(regs.get("__deleted")!.value) : false,
    data,
    version: changes[changes.length - 1]!.hlc,
  };
}

export interface RevertRecordResult {
  id: string;
  changed: boolean;
  /** Property ids whose cells were written by the revert. */
  fields: string[];
  /** True when the revert resurrected a tombstoned record. */
  undeleted: boolean;
  restored: string;
}

/** Restore a record's cells to a past version as a new forward edit. Only cells
 *  of currently-live properties are touched, so no orphan cells are recreated
 *  (the repairHub invariant). Reverting a tombstoned record resurrects it. */
export function revertRecord(db: Database, id: string, to: string): RevertRecordResult {
  const cur = db
    .query("SELECT database_id, data, __deleted FROM records WHERE id = ?")
    .get(id) as { database_id: string | null; data: string; __deleted: number } | null;
  if (!cur) throw new MhError("not_found", `no such record: ${id}`);

  const past = recordAtVersion(db, id, to);
  if (past.deleted)
    throw new MhError("invalid_input", "target version is a deleted state; use record delete instead");

  const liveProps = new Set(
    cur.database_id ? listProperties(db, cur.database_id).map((p) => p.id) : [],
  );
  const curData = JSON.parse(cur.data || "{}") as Record<string, unknown>;
  const fields: string[] = [];
  for (const propId of liveProps) {
    const inPast = Object.hasOwn(past.data, propId);
    const inCur = Object.hasOwn(curData, propId);
    if (inPast && (!inCur || JSON.stringify(past.data[propId]) !== JSON.stringify(curData[propId]))) {
      emit(db, "records", id, propId, past.data[propId]);
      fields.push(propId);
    } else if (!inPast && inCur) {
      emit(db, "records", id, propId, undefined); // clear: materializes as json_remove
      fields.push(propId);
    }
  }
  const undeleted = cur.__deleted !== 0;
  if (undeleted) emit(db, "records", id, "__deleted", 0);

  return { id, changed: fields.length > 0 || undeleted, fields, undeleted, restored: past.version };
}

export interface FieldHistoryEntry {
  version: string;
  at: string;
  node_id: string;
  /** The value written; undefined when the write cleared the cell. */
  value: unknown;
  cleared: boolean;
}

/** The full write trail of one record cell (property id), newest first. */
export function recordFieldHistory(db: Database, id: string, propId: string): FieldHistoryEntry[] {
  const rows = db
    .query(
      "SELECT hlc, node_id, value FROM crdt_changes WHERE dataset = 'records' AND row_id = ? AND col = ? ORDER BY hlc DESC",
    )
    .all(id, propId) as { hlc: string; node_id: string; value: string | null }[];
  return rows.map((r) => ({
    version: r.hlc,
    at: hlcIso(r.hlc),
    node_id: r.node_id,
    value: r.value === null ? undefined : JSON.parse(r.value),
    cleared: r.value === null,
  }));
}
