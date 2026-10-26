import { writeTx, type DbDriver } from "./driver.ts";
import { ftsAvailable } from "./schema-init.ts";
import { changesAfterSeq, type ChangeBatch } from "./crdt.ts";

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

function readMeta(db: DbDriver, key: string): string | null {
  return (
    (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)
      ?.value ?? null
  );
}

function writeMeta(db: DbDriver, key: string, value: string): void {
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


interface RecBodyRow {
  id: string;
  database_id: string | null;
  body: string | null;
}

// A record's body is the concatenation of its TEXT-typed cell values. `where`
// scopes which records to (re)derive; it is a fixed literal, never user input.
function recordBodyRows(db: DbDriver, where: string, ...args: (string | number)[]): RecBodyRow[] {
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

function insertRecordRow(db: DbDriver, r: RecBodyRow): void {
  db.query(
    "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('record', ?, ?, ?, ?)",
  ).run(r.id, r.database_id, r.id, r.body ?? "");
}

/** Keep text/body serialization inside SQLite and cross the native bridge only
 * twice per bounded ID page. A missing or tombstoned object derives no row. */
function reindexObjects(db: DbDriver, kind: "document" | "record", ids: string[]): void {
  for (let start = 0; start < ids.length; start += 200) {
    const page = ids.slice(start, start + 200);
    const placeholders = page.map(() => "?").join(",");
    db.query(`DELETE FROM search_fts WHERE kind = ? AND id IN (${placeholders})`).run(kind, ...page);
    if (kind === "document") {
      db.query(`INSERT INTO search_fts (kind, id, database_id, title, body)
        SELECT 'document', id, database_id, coalesce(title, ''), coalesce(body, '')
        FROM documents WHERE __deleted = 0 AND id IN (${placeholders})`).run(...page);
    } else {
      db.query(`INSERT INTO search_fts (kind, id, database_id, title, body)
        SELECT 'record', r.id, r.database_id, r.id, coalesce(group_concat(je.value, ' '), '')
        FROM records r, json_each(r.data) je JOIN properties p ON p.id = je.key AND p.__deleted = 0
        WHERE r.id IN (${placeholders}) AND r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
        GROUP BY r.id`).run(...page);
    }
  }
}

// Used for property-level changes (type/deletion/scope) that affect a whole
// database's records at once.
function reindexDatabaseRecords(db: DbDriver, databaseId: string): void {
  db.query("DELETE FROM search_fts WHERE kind = 'record' AND database_id = ?").run(databaseId);
  for (const r of recordBodyRows(db, "r.database_id = ?", databaseId)) insertRecordRow(db, r);
}

// --- index maintenance ------------------------------------------------------

// Full rebuild: the fallback path (first build, version bump, snapshot reset,
// manual repair). Clears the index and re-derives every object, then pins the
// cursor to the current oplog head so incremental updates pick up from there.
function fullRebuild(db: DbDriver): void {
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
  db.query("DELETE FROM meta WHERE key = 'search_rebuild'").run();
}

// Incremental: scan oplog changes since the cursor, derive the set of affected
// objects, and re-derive only those. Insertion-order (rowid) means no change is
// ever skipped, even when a remote write carries an older HLC than the local max.
function incrementalUpdate(db: DbDriver, limit?: number, batch?: ChangeBatch): void {
  const cursor = Number(readMeta(db, "search_seq") ?? "0");
  const { changes, cursor: next } = batch ?? changesAfterSeq(db, cursor, { limit });
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

  reindexObjects(db, "document", [...docIds]);
  for (const dbId of dbIds) reindexDatabaseRecords(db, dbId);
  const remaining = dbIds.size ? [...recordIds].filter(id => {
    const r = db.query("SELECT database_id FROM records WHERE id = ?").get(id) as { database_id: string | null } | null;
    return !r?.database_id || !dbIds.has(r.database_id);
  }) : [...recordIds];
  reindexObjects(db, "record", remaining);
  writeMeta(db, "search_seq", String(next));
}

// Bring the FTS index up to date before searching. Returns false when FTS5 is
// unavailable (caller falls back to LIKE). All work is one transaction so the
// cursor never advances past the index state it describes.
function ensureIndex(db: DbDriver): boolean {
  if (!ftsAvailable(db)) return false;
  const version = readMeta(db, "search_index_version");
  const seq = readMeta(db, "search_seq");
  writeTx(db, () => {
    if (version !== SEARCH_INDEX_VERSION || seq === null) fullRebuild(db);
    else incrementalUpdate(db);
  });
  return true;
}

interface SearchRebuildState { stage: "documents" | "records"; after: string; head: number }

/** Maintain at most `limit` objects or oplog entries per synchronous turn. The
 * rebuild checkpoint and index rows commit together, so app suspension or close
 * can resume without indexing the whole hub on the first keystroke. */
export function updateSearchIndexStep(db: DbDriver, limit = 200): { ready: boolean; available: boolean } {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("search batch size must be a positive integer");
  if (!ftsAvailable(db)) return { ready: true, available: false };
  return writeTx(db, () => {
    let raw = readMeta(db, "search_rebuild");
    let batch: ChangeBatch | undefined;
    if (!raw) {
      const cursor = readMeta(db, "search_seq");
      const reset = cursor === null || readMeta(db, "search_index_version") !== SEARCH_INDEX_VERSION;
      if (!reset) batch = changesAfterSeq(db, Number(cursor), { limit });
      // A property type/scope change affects every record in its database.
      const broadChange = batch?.changes.some(c => c.dataset === "properties" && ["type", "__deleted", "database_id"].includes(c.col));
      if (reset || broadChange) {
        db.query("DELETE FROM search_fts").run();
        const head = (db.query("SELECT coalesce(max(seq),0) AS n FROM crdt_changes").get() as { n: number }).n;
        raw = JSON.stringify({ stage: "documents", after: "", head } satisfies SearchRebuildState);
      }
    }
    if (raw) {
      const state = JSON.parse(raw) as SearchRebuildState;
      const table = state.stage;
      const rows = db.query(`SELECT id FROM ${table} WHERE __deleted = 0 AND id > ? ORDER BY id LIMIT ?`).all(state.after, limit) as { id: string }[];
      reindexObjects(db, state.stage === "documents" ? "document" : "record", rows.map(row => row.id));
      if (rows.length === limit) state.after = rows[rows.length - 1]!.id;
      else if (state.stage === "documents") { state.stage = "records"; state.after = ""; }
      else {
        writeMeta(db, "search_seq", String(state.head));
        writeMeta(db, "search_index_version", SEARCH_INDEX_VERSION);
        db.query("DELETE FROM meta WHERE key = 'search_rebuild'").run();
        return { ready: false, available: true }; // catch writes made during the rebuild
      }
      writeMeta(db, "search_rebuild", JSON.stringify(state));
      return { ready: false, available: true };
    }
    incrementalUpdate(db, limit, batch);
    return { ready: batch!.changes.length < limit, available: true };
  });
}

/** Async facade for a native JS-thread owner. Every database command completes
 * before yielding; cancellation prevents access after the owner closes SQLite. */
export async function searchIncrementally(db: DbDriver, query: string, opts: { limit?: number; batchSize?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  while (true) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("search cancelled");
    const step = updateSearchIndexStep(db, opts.batchSize);
    if (step.ready) break;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return search(db, query, { limit: opts.limit, maintainIndex: false });
}

/** Force a full rebuild of the search index (maintenance / repair). */
export function rebuildSearchIndex(db: DbDriver): boolean {
  if (!ftsAvailable(db)) return false;
  writeTx(db, () => fullRebuild(db));
  return true;
}

function ftsSearch(db: DbDriver, query: string, limit: number, offset = 0): SearchHit[] {
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!match) return [];
  const rows = db
    .query(
      "SELECT kind, id, database_id, title, snippet(search_fts, -1, '[', ']', '…', 10) AS snippet FROM search_fts WHERE search_fts MATCH ? ORDER BY rank, kind, id LIMIT ? OFFSET ?",
    )
    .all(match, limit, offset) as {
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
function likeSearch(db: DbDriver, query: string, limit: number): SearchHit[] {
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
  db: DbDriver,
  query: string,
  opts: { limit?: number; maintainIndex?: boolean } = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  if (opts.maintainIndex === false ? ftsAvailable(db) : ensureIndex(db)) {
    try {
      const hits = ftsSearch(db, query, limit);
      if (hits.length) return hits;
    } catch {
      // fall through to LIKE
    }
  }
  return likeSearch(db, query, limit);
}


export interface SearchQuery { offset?: number; limit?: number }
export interface SearchPage { hits: SearchHit[]; offset: number; limit: number; hasMore: boolean }

/** Paginated substring search uses one ordering across documents and records. */
function likeSearchPage(db: DbDriver, text: string, offset: number, limit: number): SearchHit[] {
  const like = `%${text.replace(/[%_\\]/g, "\\$&")}%`;
  const rows = db.query(`
    SELECT 'document' AS kind, id, database_id, title, coalesce(body, title, '') AS body
    FROM documents WHERE __deleted = 0 AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
    UNION ALL
    SELECT 'record' AS kind, r.id, r.database_id, NULL AS title, group_concat(je.value, ' ') AS body
    FROM records r, json_each(r.data) je JOIN properties p ON p.id = je.key AND p.__deleted = 0
    WHERE r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
    GROUP BY r.id HAVING body LIKE ? ESCAPE '\\'
    ORDER BY kind, id LIMIT ? OFFSET ?
  `).all(like, like, like, limit, offset) as { kind: SearchHit["type"]; id: string; database_id: string | null; title: string | null; body: string }[];
  return rows.map(row => ({ type: row.kind, id: row.id, database_id: row.database_id,
    title: row.title ?? undefined, snippet: makeSnippet(row.body, text) }));
}

/** Backend selection is based on the whole query, never the requested page.
 * Exhausting FTS therefore cannot unexpectedly switch later pages to LIKE. */
export function querySearch(db: DbDriver, text: string, query: SearchQuery & { maintainIndex?: boolean } = {}): SearchPage {
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(200, Math.floor(query.limit!))) : 50;
  text = text.trim();
  if (!text) return { hits: [], offset, limit, hasMore: false };
  let hits: SearchHit[] | undefined;
  const available = query.maintainIndex === false ? ftsAvailable(db) : ensureIndex(db);
  // CJK needs substring matching because unicode61 indexes a whole run as one token.
  if (available && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text)) {
    try {
      if (ftsSearch(db, text, 1).length) hits = ftsSearch(db, text, limit + 1, offset);
    } catch { /* Tokenizer/syntax unsupported: use the same fallback for every page. */ }
  }
  hits ??= likeSearchPage(db, text, offset, limit + 1);
  return { hits: hits.slice(0, limit), offset, limit, hasMore: hits.length > limit };
}

export async function querySearchIncrementally(db: DbDriver, text: string, query: SearchQuery & { batchSize?: number; signal?: AbortSignal } = {}): Promise<SearchPage> {
  while (true) {
    if (query.signal?.aborted) throw query.signal.reason ?? new Error("search cancelled");
    if (updateSearchIndexStep(db, query.batchSize).ready) break;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return querySearch(db, text, { ...query, maintainIndex: false });
}
