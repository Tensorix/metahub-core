import type { DbDriver } from "./driver.ts";
import { emit, grouped, CHANGE_SELECT } from "./crdt.ts";
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

export function hlcIso(hlc: string): string {
  return new Date(hlcMillis(hlc)).toISOString();
}

// A fully-read oplog row: Change with txn always present (CHANGE_SELECT
// includes it; NULL for legacy rows). The reused select list keeps these
// queries locked to the Change interface.
export interface RawChange {
  hlc: string;
  node_id: string;
  dataset: string;
  row_id: string;
  col: string;
  value: string | null;
  txn: string | null;
}

/** Where a revision came from, derived from its change-group label. */
export type RevisionKind = "user" | "repair" | "revert";

// Txn id grammar (see withChangeGroup in crdt.ts):
//   [actor "/"] [kind-label ":"] suffix
// e.g. "xxxxxxxx", "revert:xxxxxxxx", "ai/xxxxxxxx", "ai/revert:xxxxxxxx".
// The actor segment says who drove the mutation (opaque tag, e.g. "ai" for an
// agent-driven CLI), the label says what machinery wrote it. Older peers parse
// unknown-prefixed txns as kind "user" — an acceptable display-only downgrade.
export interface TxnInfo {
  actor: string | null;
  kind: RevisionKind;
}

/** Split a txn id into its actor and kind segments. */
export function parseTxn(txn: string | null): TxnInfo {
  let rest = txn ?? "";
  let actor: string | null = null;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    actor = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  const kind: RevisionKind = rest.startsWith("repair:")
    ? "repair"
    : rest.startsWith("revert:")
      ? "revert"
      : "user";
  return { actor, kind };
}

function revisionKind(txn: string | null): RevisionKind {
  return parseTxn(txn).kind;
}

/**
 * Group an HLC-ordered change stream into revisions. Changes sharing a txn are
 * one revision; between txn-less changes (legacy rows, pre-txn peers) fall back
 * to author + wall-clock gap. Clustering depends only on oplog content, so
 * every synced node renders the same list.
 */
export function clusterRevisions(changes: RawChange[]): RawChange[][] {
  const groups: RawChange[][] = [];
  let cur: RawChange[] = [];
  for (const c of changes) {
    const prev = cur[cur.length - 1];
    const boundary =
      prev &&
      (prev.txn !== null && c.txn !== null
        ? prev.txn !== c.txn
        : prev.node_id !== c.node_id || hlcMillis(c.hlc) - hlcMillis(prev.hlc) > REVISION_GAP_MS);
    if (boundary) {
      groups.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** True when a JSON-encoded oplog value is a truthy flag (e.g. __deleted = 1). */
export function flagSet(value: string | null): boolean {
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
function rowChanges(db: DbDriver, dataset: string, rowId: string): RawChange[] {
  return db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes WHERE dataset = ? AND row_id = ? ORDER BY hlc`,
    )
    .all(dataset, rowId) as RawChange[];
}

// ---- documents ---------------------------------------------------------------

/** Ids of every block that was ever assigned to this document. Whether a block
 *  counts at a given cutoff is decided later from its registers at that cutoff. */
function everBlockIds(db: DbDriver, docId: string): string[] {
  return (
    db
      .query(
        "SELECT DISTINCT row_id FROM crdt_changes WHERE dataset = 'doc_blocks' AND col = 'doc_id' AND value = ?",
      )
      .all(JSON.stringify(docId)) as { row_id: string }[]
  ).map((r) => r.row_id);
}

/** Doc register changes + changes of every block ever attached, in HLC order. */
function docChanges(db: DbDriver, docId: string): RawChange[] {
  const blocks = everBlockIds(db, docId);
  const placeholders = blocks.map(() => "?").join(",");
  const blockClause = blocks.length
    ? ` OR (dataset = 'doc_blocks' AND row_id IN (${placeholders}))`
    : "";
  return db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes
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
  /** Source of the revision: a user edit, a repairHub fix, or a revert. */
  kind: RevisionKind;
  /** Actor tag from the txn's actor segment (e.g. "ai"), null for untagged. */
  actor: string | null;
  changes: number;
  created: boolean;
  deleted: boolean;
  title_changed: boolean;
  blocks_changed: number;
  blocks_deleted: number;
}

/** A document's edit history, newest first, clustered into save-sized revisions. */
export function listDocumentRevisions(db: DbDriver, id: string): DocRevision[] {
  const changes = docChanges(db, id);
  if (!changes.length) throw new MhError("not_found", `no such document: ${id}`);
  // Running values of the doc-level registers, so flags reflect VALUE changes,
  // not mere register writes. Historical oplogs are full of same-value title
  // re-asserts (autosave used to send the title unconditionally); comparing
  // values keeps those from flagging every revision as "title changed", and a
  // group that changes nothing at all (only no-op re-asserts) is dropped.
  const reg = new Map<string, string | null>();
  const out: DocRevision[] = [];
  for (const group of clusterRevisions(changes)) {
    const changedBlocks = new Set<string>();
    const deletedBlocks = new Set<string>();
    const docWrites = new Map<string, string | null>(); // col -> last value in group
    let created = false;
    let deleted = false;
    let blockWrites = 0;
    for (const c of group) {
      if (c.dataset === "documents") {
        docWrites.set(c.col, c.value);
        if (c.col === "created_hlc") created = true;
        else if (c.col === "__deleted") deleted = flagSet(c.value);
      } else {
        blockWrites++;
        if (c.col === "__deleted" && flagSet(c.value)) deletedBlocks.add(c.row_id);
        else if (c.col === "text") changedBlocks.add(c.row_id);
      }
    }
    let titleChanged = false;
    let docEffects = 0;
    for (const [col, value] of docWrites) {
      // Unknown prior value (first sight, or compacted-away history) counts as
      // a change — dropping a revision must never be a guess.
      const changed = !reg.has(col) || reg.get(col) !== value;
      reg.set(col, value);
      if (!changed) continue;
      docEffects++;
      if (col === "title") titleChanged = true;
    }
    if (docEffects === 0 && blockWrites === 0) continue;
    const last = group[group.length - 1]!;
    out.push({
      version: last.hlc,
      at: hlcIso(last.hlc),
      node_id: last.node_id,
      kind: revisionKind(last.txn),
      actor: parseTxn(last.txn).actor,
      changes: group.length,
      created,
      deleted,
      title_changed: titleChanged,
      blocks_changed: changedBlocks.size,
      blocks_deleted: deletedBlocks.size,
    });
  }
  return out.reverse();
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
export function documentAtVersion(db: DbDriver, id: string, at: string): DocumentVersionState {
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
  /** True when the revert resurrected a tombstoned document. */
  undeleted: boolean;
}

/**
 * Restore a document's title/body to a past version, as a new forward edit
 * (reuses updateDocument's block reconcile, so unchanged blocks keep identity).
 * Reverting a tombstoned document resurrects it; children unparented by the
 * delete stay where they are. One change group, so history shows ONE revision.
 */
export const revertDocument = grouped(function revertDocument(
  db: DbDriver,
  id: string,
  to: string,
  opts: { ifMatch?: string } = {},
): RevertDocResult {
  let cur = getDocument(db, id);
  if (!cur && !db.query("SELECT 1 AS x FROM documents WHERE id = ?").get(id))
    throw new MhError("not_found", `no such document: ${id}`);
  if (opts.ifMatch !== undefined && documentVersion(db, id) !== opts.ifMatch)
    throw new MhError("stale", `stale: document changed since ${opts.ifMatch}; re-read first`);

  const past = documentAtVersion(db, id, to);
  if (past.deleted)
    throw new MhError("invalid_input", "target version is a deleted state; use doc delete instead");

  const undeleted = !cur;
  if (!cur) {
    // Resurrect the doc row; its blocks stay tombstoned (the body cache is empty),
    // so the body restore below re-inserts the past blocks via reconcile.
    emit(db, "documents", id, "__deleted", 0);
    cur = getDocument(db, id)!;
  }

  const fields: { title?: string; body?: string } = {};
  if (past.title !== cur.title) fields.title = past.title;
  if (past.body !== (cur.body ?? "")) fields.body = past.body;
  if (Object.keys(fields).length) updateDocument(db, id, fields);

  return {
    id,
    changed: Object.keys(fields).length > 0 || undeleted,
    restored: past.version,
    version: documentVersion(db, id),
    undeleted,
  };
}, "revert");

// ---- records -------------------------------------------------------------------

/** records-dataset meta columns; every other col is a property cell. */
const RECORD_META = new Set(["database_id", "created_hlc", "order_key", "__deleted"]);

export interface RecordRevision {
  version: string;
  at: string;
  node_id: string;
  kind: RevisionKind;
  /** Actor tag from the txn's actor segment (e.g. "ai"), null for untagged. */
  actor: string | null;
  changes: number;
  created: boolean;
  deleted: boolean;
  /** Property ids of the cells written in this revision. */
  fields: string[];
  moved: boolean;
}

/** Summarize one change group of a record into a revision. */
function recordRevisionOf(group: RawChange[]): RecordRevision {
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
    kind: revisionKind(last.txn),
    actor: parseTxn(last.txn).actor,
    changes: group.length,
    created,
    deleted,
    fields: [...fields],
    moved,
  };
}

/** A record's edit history, newest first, clustered into save-sized revisions. */
export function listRecordRevisions(db: DbDriver, id: string): RecordRevision[] {
  const changes = rowChanges(db, "records", id);
  if (!changes.length) throw new MhError("not_found", `no such record: ${id}`);
  return clusterRevisions(changes).map(recordRevisionOf).reverse();
}

/** One cell's value change inside a revision. A missing `before`/`after` key
 *  means the cell did not exist on that side (distinct from an explicit null). */
export interface FieldChange {
  prop: string;
  before?: unknown;
  after?: unknown;
}

export interface DatabaseActivityEntry extends RecordRevision {
  record_id: string;
  /** Title-property value as of this revision — deleted records keep their last title. */
  record_title: string | null;
  /** Value-level changes of the touched cells. */
  diffs: FieldChange[];
}

/**
 * "What happened in this table lately": every record's revisions, merged and
 * sorted newest first. Includes tombstoned records (so deletions show up) — a
 * read-only aggregation, same clustering as listRecordRevisions per record.
 * Walking each record's change stream oldest-first lets us carry a running
 * cell-state map, so every entry ships its old→new values and a title snapshot
 * for free (no extra queries). After compaction, `before` at the window edge
 * may be missing (the superseded write was pruned) — it reads as "was empty".
 */
export function listDatabaseActivity(
  db: DbDriver,
  databaseId: string,
  opts: { limit?: number } = {},
): DatabaseActivityEntry[] {
  if (!db.query("SELECT 1 AS x FROM databases WHERE id = ?").get(databaseId))
    throw new MhError("not_found", `no such database: ${databaseId}`);
  // The first live text property is the de-facto record title (same rule the
  // reference resolver uses).
  const titleProp =
    (
      db
        .query(
          "SELECT id FROM properties WHERE database_id = ? AND type = 'text' AND __deleted = 0 ORDER BY position LIMIT 1",
        )
        .get(databaseId) as { id: string } | null
    )?.id ?? null;

  const changes = db
    .query(
      `SELECT ${CHANGE_SELECT} FROM crdt_changes
       WHERE dataset = 'records' AND row_id IN (SELECT id FROM records WHERE database_id = ?)
       ORDER BY row_id, hlc`,
    )
    .all(databaseId) as RawChange[];

  const out: DatabaseActivityEntry[] = [];
  let start = 0;
  for (let i = 1; i <= changes.length; i++) {
    if (i !== changes.length && changes[i]!.row_id === changes[start]!.row_id) continue;
    const rowId = changes[start]!.row_id;
    // Running cell state, mirroring materialize(): null value = json_remove.
    const state = new Map<string, unknown>();
    for (const g of clusterRevisions(changes.slice(start, i))) {
      const touched = new Set<string>();
      for (const c of g) if (!RECORD_META.has(c.col)) touched.add(c.col);
      const before = new Map<string, unknown>();
      for (const col of touched) if (state.has(col)) before.set(col, state.get(col));
      for (const c of g) {
        if (RECORD_META.has(c.col)) continue;
        if (c.value === null) state.delete(c.col);
        else state.set(c.col, JSON.parse(c.value));
      }
      const diffs: FieldChange[] = [];
      for (const col of touched) {
        const fc: FieldChange = { prop: col };
        if (before.has(col)) fc.before = before.get(col);
        if (state.has(col)) fc.after = state.get(col);
        diffs.push(fc);
      }
      out.push({
        ...recordRevisionOf(g),
        record_id: rowId,
        record_title:
          titleProp && state.has(titleProp) ? String(state.get(titleProp) ?? "") : null,
        diffs,
      });
    }
    start = i;
  }
  out.sort((a, b) => (a.version < b.version ? 1 : -1));
  return out.slice(0, opts.limit ?? 100);
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
export function recordAtVersion(db: DbDriver, id: string, at: string): RecordVersionState {
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
export const revertRecord = grouped(function revertRecord(
  db: DbDriver,
  id: string,
  to: string,
): RevertRecordResult {
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
}, "revert");

// ---- properties (schema-level rollback) ------------------------------------------

/** Property register columns that make up the column definition. */
const PROP_DEF_COLS = ["name", "type", "config", "position"] as const;

export interface PropertyRevision {
  version: string;
  at: string;
  node_id: string;
  kind: RevisionKind;
  /** Actor tag from the txn's actor segment (e.g. "ai"), null for untagged. */
  actor: string | null;
  changes: number;
  created: boolean;
  deleted: boolean;
  /** Definition columns touched in this revision (name/type/config/position). */
  fields: string[];
  /** Record cells the same change group cleared (a type change / removal cascade). */
  cells_cleared: number;
}

/** A property's definition history, newest first. Cascaded cell clears are
 *  counted via the shared txn so a type change reads as one revision. */
export function listPropertyRevisions(db: DbDriver, id: string): PropertyRevision[] {
  const changes = rowChanges(db, "properties", id);
  if (!changes.length) throw new MhError("not_found", `no such property: ${id}`);
  const clearedByTxn = new Map<string, number>(
    (
      db
        .query(
          "SELECT txn, COUNT(*) AS n FROM crdt_changes WHERE dataset = 'records' AND col = ? AND txn IS NOT NULL GROUP BY txn",
        )
        .all(id) as { txn: string; n: number }[]
    ).map((r) => [r.txn, r.n]),
  );
  return clusterRevisions(changes)
    .map((group) => {
      const fields = new Set<string>();
      let created = false;
      let deleted = false;
      for (const c of group) {
        if (c.col === "database_id") created = true; // only emitted at creation
        else if (c.col === "__deleted") deleted = flagSet(c.value);
        else if ((PROP_DEF_COLS as readonly string[]).includes(c.col)) fields.add(c.col);
      }
      const last = group[group.length - 1]!;
      return {
        version: last.hlc,
        at: hlcIso(last.hlc),
        node_id: last.node_id,
        kind: revisionKind(last.txn),
        actor: parseTxn(last.txn).actor,
        changes: group.length,
        created,
        deleted,
        fields: [...fields],
        cells_cleared: last.txn ? (clearedByTxn.get(last.txn) ?? 0) : 0,
      };
    })
    .reverse();
}

export interface PropertyVersionState {
  id: string;
  database_id: string | null;
  name: string;
  type: string;
  config: unknown;
  position: number | null;
  deleted: boolean;
  version: string;
}

/** Reconstruct a property definition as of version cutoff `at`. */
export function propertyAtVersion(db: DbDriver, id: string, at: string): PropertyVersionState {
  if (!at) throw new MhError("invalid_input", "missing version cutoff");
  const changes = rowChanges(db, "properties", id).filter((c) => c.hlc <= at);
  if (!changes.length)
    throw new MhError("not_found", `no version of property ${id} at or before ${at}`);
  const regs = registersAt(changes, at);
  const reg = (col: string): unknown => {
    const r = regs.get(col);
    return r?.value == null ? undefined : JSON.parse(r.value);
  };
  return {
    id,
    database_id: (reg("database_id") as string | undefined) ?? null,
    name: (reg("name") as string | undefined) ?? "",
    type: (reg("type") as string | undefined) ?? "text",
    config: reg("config") ?? null,
    position: (reg("position") as number | undefined) ?? null,
    deleted: regs.get("__deleted") ? flagSet(regs.get("__deleted")!.value) : false,
    version: changes[changes.length - 1]!.hlc,
  };
}

export interface RevertPropertyResult {
  id: string;
  changed: boolean;
  /** Definition columns the revert wrote. */
  fields: string[];
  /** Record cells restored to their value at the target version. */
  restored_cells: number;
  /** Cells left alone because a user wrote them after the target version. */
  skipped_cells: number;
  undeleted: boolean;
  restored: string;
}

/**
 * Schema-level rollback: restore a property's definition AND the record cells
 * its later type-change/removal cascades cleared. Definition registers are
 * emitted directly (never via updateProperty — its type-change cascade would
 * re-clear the cells being restored). A cell is only touched when its current
 * winner IS the cascade (or a repair); it is restored to the last value before
 * that cascade, so user data — written before or after the target version —
 * always survives. Cells whose winner is a user write are kept (skipped_cells).
 * Pre-txn legacy writes can't be attributed, so they count as user writes.
 */
export const revertProperty = grouped(function revertProperty(
  db: DbDriver,
  id: string,
  to: string,
): RevertPropertyResult {
  const cur = db
    .query(
      "SELECT database_id, name, type, config, position, __deleted FROM properties WHERE id = ?",
    )
    .get(id) as {
    database_id: string | null;
    name: string | null;
    type: string | null;
    config: string | null;
    position: number | null;
    __deleted: number;
  } | null;
  if (!cur) throw new MhError("not_found", `no such property: ${id}`);

  const past = propertyAtVersion(db, id, to);
  if (past.deleted)
    throw new MhError("invalid_input", "target version is a deleted state; use prop remove instead");

  // 1) Restore the column definition (diff only — no cascades).
  const curDef: Record<string, unknown> = {
    name: cur.name,
    type: cur.type,
    config: cur.config ? JSON.parse(cur.config) : null,
    position: cur.position,
  };
  const pastDef: Record<string, unknown> = {
    name: past.name,
    type: past.type,
    config: past.config,
    position: past.position,
  };
  const fields: string[] = [];
  for (const col of PROP_DEF_COLS) {
    if (JSON.stringify(pastDef[col] ?? null) !== JSON.stringify(curDef[col] ?? null)) {
      emit(db, "properties", id, col, pastDef[col]);
      fields.push(col);
    }
  }
  const undeleted = cur.__deleted !== 0;
  if (undeleted) emit(db, "properties", id, "__deleted", 0);

  // 2) Restore the cells. Cascade writes are identified by sharing a txn with a
  //    post-target change to this property's own registers.
  const schemaTxns = new Set(
    (
      db
        .query(
          "SELECT DISTINCT txn FROM crdt_changes WHERE dataset = 'properties' AND row_id = ? AND hlc > ? AND txn IS NOT NULL",
        )
        .all(id, to) as { txn: string }[]
    ).map((r) => r.txn),
  );
  const cellChanges = db
    .query(
      "SELECT row_id, hlc, value, txn FROM crdt_changes WHERE dataset = 'records' AND col = ? ORDER BY row_id, hlc",
    )
    .all(id) as { row_id: string; hlc: string; value: string | null; txn: string | null }[];

  const isCascade = (txn: string | null): boolean =>
    txn !== null && (schemaTxns.has(txn) || parseTxn(txn).kind === "repair");

  let restored = 0;
  let skipped = 0;
  let i = 0;
  while (i < cellChanges.length) {
    const rowId = cellChanges[i]!.row_id;
    let winner = cellChanges[i]!;
    let lastUser: { value: string | null } | null = null; // latest non-cascade write
    for (; i < cellChanges.length && cellChanges[i]!.row_id === rowId; i++) {
      winner = cellChanges[i]!;
      if (!isCascade(winner.txn)) lastUser = winner;
    }
    if (winner.hlc <= to) continue; // untouched since the target version
    if (!isCascade(winner.txn)) {
      skipped++; // current value is a user write — keep it
      continue;
    }
    const target = lastUser ? lastUser.value : null; // null = cell never had a user value
    if (target === winner.value) continue; // converged back on its own
    emit(db, "records", rowId, id, target === null ? undefined : JSON.parse(target));
    restored++;
  }

  return {
    id,
    changed: fields.length > 0 || undeleted || restored > 0,
    fields,
    restored_cells: restored,
    skipped_cells: skipped,
    undeleted,
    restored: past.version,
  };
}, "revert");

export interface FieldHistoryEntry {
  version: string;
  at: string;
  node_id: string;
  /** The value written; undefined when the write cleared the cell. */
  value: unknown;
  cleared: boolean;
}

/** The full write trail of one record cell (property id), newest first. */
export function recordFieldHistory(db: DbDriver, id: string, propId: string): FieldHistoryEntry[] {
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
