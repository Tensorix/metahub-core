import type { Database } from "bun:sqlite";
import { ftsAvailable } from "./db.ts";
import { changesAfterSeq } from "./crdt.ts";

export interface SearchHit {
  type: "document" | "record";
  id: string;
  database_id: string | null;
  title?: string;
  snippet: string;
}

const TEXT_TYPES = "('text','url','select','multi_select','date')";

// Bump when the indexing logic changes (TEXT_TYPES, indexed columns, FTS schema)
// so existing hubs discard `search_seq` and rebuild from scratch on next search.
const SEARCH_INDEX_VERSION = "1";

function readMeta(db: Database, key: string): string | null {
  return (
    (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)
      ?.value ?? null
  );
}

function writeMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// --- per-object (re)indexing ------------------------------------------------
// FTS rows are derived from the materialized tables, so (re)indexing one object
// is "delete its rows, then re-derive from the live row(s)". A tombstoned or
// body-less object simply re-derives to nothing.

interface DocRow {
  id: string;
  title: string | null;
  body: string | null;
  database_id: string | null;
}

function reindexDocument(db: Database, id: string): void {
  db.query("DELETE FROM search_fts WHERE kind = 'document' AND id = ?").run(id);
  const d = db
    .query("SELECT id, title, body, database_id FROM documents WHERE id = ? AND __deleted = 0")
    .get(id) as DocRow | null;
  if (d)
    db.query(
      "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('document', ?, ?, ?, ?)",
    ).run(d.id, d.database_id, d.title ?? "", d.body ?? "");
}

interface RecBodyRow {
  id: string;
  database_id: string | null;
  body: string | null;
}

// A record's body is the concatenation of its TEXT-typed cell values. `where`
// scopes which records to (re)derive; it is a fixed literal, never user input.
function recordBodyRows(db: Database, where: string, ...args: (string | number)[]): RecBodyRow[] {
  return db
    .query(
      `SELECT r.id AS id, r.database_id AS database_id, group_concat(je.value, ' ') AS body
       FROM records r, json_each(r.data) je
       JOIN properties p ON p.id = je.key AND p.__deleted = 0
       WHERE ${where} AND r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
       GROUP BY r.id`,
    )
    .all(...args) as RecBodyRow[];
}

function insertRecordRow(db: Database, r: RecBodyRow): void {
  db.query(
    "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('record', ?, ?, ?, ?)",
  ).run(r.id, r.database_id, r.id, r.body ?? "");
}

function reindexRecord(db: Database, id: string): void {
  db.query("DELETE FROM search_fts WHERE kind = 'record' AND id = ?").run(id);
  const r = recordBodyRows(db, "r.id = ?", id)[0];
  if (r) insertRecordRow(db, r);
}

// Used for property-level changes (type/deletion/scope) that affect a whole
// database's records at once.
function reindexDatabaseRecords(db: Database, databaseId: string): void {
  db.query("DELETE FROM search_fts WHERE kind = 'record' AND database_id = ?").run(databaseId);
  for (const r of recordBodyRows(db, "r.database_id = ?", databaseId)) insertRecordRow(db, r);
}

// --- index maintenance ------------------------------------------------------

// Full rebuild: the fallback path (first build, version bump, snapshot reset,
// manual repair). Clears the index and re-derives every object, then pins the
// cursor to the current oplog head so incremental updates pick up from there.
function fullRebuild(db: Database): void {
  db.query("DELETE FROM search_fts").run();
  for (const d of db
    .query("SELECT id, title, body, database_id FROM documents WHERE __deleted = 0")
    .all() as DocRow[])
    db.query(
      "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('document', ?, ?, ?, ?)",
    ).run(d.id, d.database_id, d.title ?? "", d.body ?? "");
  for (const r of recordBodyRows(db, "1 = 1")) insertRecordRow(db, r);
  const max = (db.query("SELECT MAX(rowid) AS m FROM crdt_changes").get() as { m: number | null }).m ?? 0;
  writeMeta(db, "search_seq", String(max));
  writeMeta(db, "search_index_version", SEARCH_INDEX_VERSION);
}

// Incremental: scan oplog changes since the cursor, derive the set of affected
// objects, and re-derive only those. Insertion-order (rowid) means no change is
// ever skipped, even when a remote write carries an older HLC than the local max.
function incrementalUpdate(db: Database): void {
  const cursor = Number(readMeta(db, "search_seq") ?? "0");
  const { changes, cursor: next } = changesAfterSeq(db, cursor);
  if (changes.length === 0) return;

  const docIds = new Set<string>();
  const recordIds = new Set<string>();
  const dbIds = new Set<string>(); // databases whose records need a full re-derive

  for (const c of changes) {
    switch (c.dataset) {
      case "documents":
        docIds.add(c.row_id);
        break;
      case "doc_blocks": {
        const blk = db
          .query("SELECT doc_id FROM doc_blocks WHERE id = ?")
          .get(c.row_id) as { doc_id: string | null } | null;
        if (blk?.doc_id) docIds.add(blk.doc_id);
        break;
      }
      case "records":
        recordIds.add(c.row_id);
        break;
      case "properties":
        // Only type/deletion/scope change which cells contribute to record bodies.
        if (c.col === "type" || c.col === "__deleted" || c.col === "database_id") {
          const p = db
            .query("SELECT database_id FROM properties WHERE id = ?")
            .get(c.row_id) as { database_id: string | null } | null;
          if (p?.database_id) dbIds.add(p.database_id);
        }
        break;
      // databases / sites / site_files are not represented in the FTS index.
    }
  }

  for (const id of docIds) reindexDocument(db, id);
  for (const dbId of dbIds) reindexDatabaseRecords(db, dbId);
  for (const id of recordIds) {
    const r = db
      .query("SELECT database_id FROM records WHERE id = ?")
      .get(id) as { database_id: string | null } | null;
    if (r?.database_id && dbIds.has(r.database_id)) continue; // already covered above
    reindexRecord(db, id);
  }
  writeMeta(db, "search_seq", String(next));
}

// Bring the FTS index up to date before searching. Returns false when FTS5 is
// unavailable (caller falls back to LIKE). All work is one transaction so the
// cursor never advances past the index state it describes.
function ensureIndex(db: Database): boolean {
  if (!ftsAvailable(db)) return false;
  const version = readMeta(db, "search_index_version");
  const seq = readMeta(db, "search_seq");
  db.transaction(() => {
    if (version !== SEARCH_INDEX_VERSION || seq === null) fullRebuild(db);
    else incrementalUpdate(db);
  })();
  return true;
}

/** Force a full rebuild of the search index (maintenance / repair). */
export function rebuildSearchIndex(db: Database): boolean {
  if (!ftsAvailable(db)) return false;
  db.transaction(() => fullRebuild(db))();
  return true;
}

function ftsSearch(db: Database, query: string, limit: number): SearchHit[] {
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!match) return [];
  const rows = db
    .query(
      "SELECT kind, id, database_id, title, snippet(search_fts, -1, '[', ']', '…', 10) AS snippet FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(match, limit) as {
    kind: "document" | "record";
    id: string;
    database_id: string | null;
    title: string | null;
    snippet: string;
  }[];
  return rows.map((r) => ({
    type: r.kind,
    id: r.id,
    database_id: r.database_id,
    title: r.title || undefined,
    snippet: r.snippet,
  }));
}

function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, i + q.length + 50)}…`;
}

// Substring match — robust for CJK and exact phrases where FTS tokenization misses.
function likeSearch(db: Database, query: string, limit: number): SearchHit[] {
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const out: SearchHit[] = [];
  const docs = db
    .query(
      "SELECT id, title, body, database_id FROM documents WHERE __deleted = 0 AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') LIMIT ?",
    )
    .all(like, like, limit) as {
    id: string;
    title: string | null;
    body: string | null;
    database_id: string | null;
  }[];
  for (const d of docs)
    out.push({
      type: "document",
      id: d.id,
      database_id: d.database_id,
      title: d.title ?? undefined,
      snippet: makeSnippet(d.body || d.title || "", query),
    });

  if (out.length < limit) {
    const recs = db
      .query(
        `SELECT r.id AS id, r.database_id AS database_id, group_concat(je.value, ' ') AS body
         FROM records r, json_each(r.data) je
         JOIN properties p ON p.id = je.key AND p.__deleted = 0
         WHERE r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
         GROUP BY r.id HAVING body LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(like, limit - out.length) as {
      id: string;
      database_id: string | null;
      body: string | null;
    }[];
    for (const r of recs)
      out.push({
        type: "record",
        id: r.id,
        database_id: r.database_id,
        snippet: makeSnippet(r.body || "", query),
      });
  }
  return out;
}

export function search(
  db: Database,
  query: string,
  opts: { limit?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  if (ensureIndex(db)) {
    try {
      const hits = ftsSearch(db, query, limit);
      if (hits.length) return hits;
    } catch {
      // fall through to LIKE
    }
  }
  return likeSearch(db, query, limit);
}
