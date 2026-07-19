// Runtime-agnostic schema bootstrap: everything needed to bring a metahub
// database to the current schema, typed against the portable driver surface so
// it runs both on Bun (bun:sqlite) and in a browser worker (sqlite-wasm).
// Opening the on-disk database lives in db.ts, which composes these.

import type { DbDriver } from "./driver.ts";
import { CORE_SCHEMA, FTS_SCHEMA } from "./schema.ts";
import { backfillRecordOrderKeys } from "./records.ts";
import { backfillDocumentOrderKeys } from "./documents.ts";
import { readPolicy, setFullNodes } from "./blobs-core.ts";
import { storageUrl } from "./sync/storage-url.ts";

export function runSchema(db: DbDriver): void {
  db.exec(CORE_SCHEMA);
  try {
    db.exec(FTS_SCHEMA);
  } catch {
    // FTS5 unavailable; search will fall back to LIKE.
  }
}

export function ftsAvailable(db: DbDriver): boolean {
  const row = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'search_fts'")
    .get() as { ok: number } | null;
  return row != null;
}

function hasColumn(db: DbDriver, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(db: DbDriver, table: string): boolean {
  return (
    db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

/**
 * Migrate legacy EAV records (record_values: one row per cell) to the JSON
 * layout (records.data: one row per record). Idempotent — keyed off schema
 * shape, no version flag. A no-op for fresh databases.
 */
export function migrateRecords(db: DbDriver): void {
  if (!hasColumn(db, "records", "data"))
    db.exec("ALTER TABLE records ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
  if (!hasColumn(db, "records", "order_key"))
    db.exec("ALTER TABLE records ADD COLUMN order_key TEXT");

  if (!tableExists(db, "record_values")) return;

  const tx = db.transaction(() => {
    // Fold each record's cells into a JSON object keyed by property id.
    db.exec(`
      UPDATE records SET data = coalesce((
        SELECT json_group_object(rv.property_id, json(rv.value))
        FROM record_values rv WHERE rv.record_id = records.id
      ), '{}')
      WHERE id IN (SELECT DISTINCT record_id FROM record_values);
    `);
    db.exec("DROP TABLE record_values");
    backfillRecordOrderKeys(db);
  });
  tx();

  backfillRecordOrderKeys(db);
}

/**
 * Add the peer-pairing columns to a legacy `peers` table (token/label/node_id/
 * enabled/last_sync_at/last_success_at/last_status/last_error). Idempotent —
 * guarded per column, never drops the table so existing replication cursors survive.
 */
/** Add `served_base` / `grants` to a `shares` table created before the columns
 *  existed (idempotent). The vestigial s3_* columns are left as-is. `grants` is
 *  node-local like the rest of the row (never in the oplog), so unlike the
 *  synced sites columns there is nothing to backfill. */
export function migrateShares(db: DbDriver): void {
  if (!hasColumn(db, "shares", "served_base"))
    db.exec("ALTER TABLE shares ADD COLUMN served_base TEXT");
  if (!hasColumn(db, "shares", "grants"))
    db.exec("ALTER TABLE shares ADD COLUMN grants TEXT");
}

export function migratePeers(db: DbDriver): void {
  const add: [string, string][] = [
    ["token", "TEXT"],
    ["label", "TEXT"],
    ["node_id", "TEXT"],
    ["enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["last_sync_at", "INTEGER"],
    ["last_success_at", "INTEGER"],
    ["last_status", "TEXT"],
    ["last_error", "TEXT"],
    // Storage-sync (sync/storage.ts): kind selects the transport, config holds
    // an 's3' peer's bucket settings. Legacy rows default to 'http', unchanged.
    ["kind", "TEXT NOT NULL DEFAULT 'http'"],
    ["config", "TEXT"],
  ];
  for (const [col, decl] of add) {
    if (!hasColumn(db, "peers", col)) db.exec(`ALTER TABLE peers ADD COLUMN ${col} ${decl}`);
  }
  db.exec(
    "UPDATE peers SET last_success_at = last_sync_at " +
      "WHERE last_success_at IS NULL AND last_status = 'ok' AND last_sync_at IS NOT NULL",
  );
}

/**
 * Add the `blank_after` column to a legacy `doc_blocks` table. Idempotent —
 * guarded by hasColumn; existing blocks default to 0 (canonical single-blank-line
 * separators), so the migration never changes an existing document's body.
 */
export function migrateDocBlocks(db: DbDriver): void {
  if (!hasColumn(db, "doc_blocks", "blank_after"))
    db.exec("ALTER TABLE doc_blocks ADD COLUMN blank_after INTEGER NOT NULL DEFAULT 0");
}

/**
 * Bring a legacy `blob_cache` to the current shape and retire the old synced
 * `blob_presence` table. Idempotent (guarded by hasColumn / IF EXISTS).
 *  - `pinned`: node-local, never auto-evicted/cleared.
 *  - `pending`: bytes produced here, not yet flushed to a durable anchor. Existing
 *    rows can't be classified produced-vs-acquired, so default to 1 (protected);
 *    the next online flush sets already-in-bucket blobs back to 0, so it self-heals
 *    and is loss-free. See blobs.ts.
 *  - `blob_presence` (was synced) is dropped: clearing is now decided locally from
 *    `pending`. Leftover presence oplog changes are ignored (forward-compat).
 */
export function migrateBlobCache(db: DbDriver): void {
  if (!hasColumn(db, "blob_cache", "pinned"))
    db.exec("ALTER TABLE blob_cache ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn(db, "blob_cache", "pending"))
    db.exec("ALTER TABLE blob_cache ADD COLUMN pending INTEGER NOT NULL DEFAULT 1");
  if (!hasColumn(db, "blob_cache", "anchored"))
    db.exec("ALTER TABLE blob_cache ADD COLUMN anchored INTEGER NOT NULL DEFAULT 0");
  db.exec("DROP TABLE IF EXISTS blob_presence");
}

/**
 * Add the `order_key` column to a legacy `documents` table and backfill it.
 * Idempotent — guarded by hasColumn; backfill only touches rows with a NULL key,
 * assigning per-parent fractional indices in current created_hlc order, so the
 * displayed document order is unchanged until the user first drags something.
 */
export function migrateDocuments(db: DbDriver): void {
  if (!hasColumn(db, "documents", "order_key"))
    db.exec("ALTER TABLE documents ADD COLUMN order_key TEXT");
  backfillDocumentOrderKeys(db);
}

/**
 * Add the `txn` change-group column to a legacy `crdt_changes` table.
 * Idempotent — guarded by hasColumn; existing rows stay NULL (history falls
 * back to time-gap clustering for them).
 */
export function migrateOplog(db: DbDriver): void {
  if (!hasColumn(db, "crdt_changes", "txn"))
    db.exec("ALTER TABLE crdt_changes ADD COLUMN txn TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_changes_txn ON crdt_changes(txn) WHERE txn IS NOT NULL");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_changes_intent_receipt_hlc ON crdt_changes(hlc) WHERE dataset = 'intent_receipts'",
  );
}

/**
 * Rebuild a legacy `crdt_changes` (composite PRIMARY KEY, implicit rowid) into
 * the current shape with an explicit `seq INTEGER PRIMARY KEY AUTOINCREMENT`.
 *
 * Why: replication push/pull cursors are crdt_changes rowids. The legacy table
 * has no declared INTEGER PRIMARY KEY, so a `VACUUM` (run by `mh` compaction)
 * renumbers its rowids 1..N; a peer's stored cursor then sits above the new
 * MAX(rowid) and `changesAfterSeq`'s "never regress" floor pins it there,
 * silently never pushing/pulling the writes below it. The declared `seq` is
 * stable across VACUUM and never reused, closing the hole.
 *
 * Idempotent — guarded by the `seq` column. Old rowids are copied verbatim into
 * seq so any *uncorrupted* cursor stays meaningful; then push/pull cursors are
 * reset to 0 because we cannot tell which were already stranded by a past
 * VACUUM, and a from-scratch re-sync is safe (INSERT OR IGNORE / ingest dedup)
 * — a one-time catch-up on first sync after upgrade. storage_cursors are
 * object-key based, never rowids, so they are left intact.
 */
export function migrateCrdtChangesSeq(db: DbDriver): void {
  if (hasColumn(db, "crdt_changes", "seq")) return;
  const tx = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS crdt_changes_new;
      CREATE TABLE crdt_changes_new (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        hlc     TEXT NOT NULL,
        node_id TEXT NOT NULL,
        dataset TEXT NOT NULL,
        row_id  TEXT NOT NULL,
        col     TEXT NOT NULL,
        value   TEXT,
        txn     TEXT,
        UNIQUE (dataset, row_id, col, hlc)
      );
      INSERT INTO crdt_changes_new (seq, hlc, node_id, dataset, row_id, col, value, txn)
        SELECT rowid, hlc, node_id, dataset, row_id, col, value, txn
        FROM crdt_changes ORDER BY rowid;
      DROP TABLE crdt_changes;
      ALTER TABLE crdt_changes_new RENAME TO crdt_changes;
      CREATE INDEX IF NOT EXISTS idx_changes_hlc ON crdt_changes(hlc);
      CREATE INDEX IF NOT EXISTS idx_changes_txn ON crdt_changes(txn)
        WHERE txn IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_changes_intent_receipt_hlc ON crdt_changes(hlc)
        WHERE dataset = 'intent_receipts';
      CREATE INDEX IF NOT EXISTS idx_changes_docref ON crdt_changes(value)
        WHERE dataset = 'doc_blocks' AND col = 'doc_id';
    `);
    if (tableExists(db, "peers")) db.exec("UPDATE peers SET push_cursor = 0, pull_cursor = 0");
  });
  tx();
}

/**
 * Migrate legacy storage-peer keys `s3://<bucket>/<prefix>` to the
 * endpoint-qualified `s3://<host>/<bucket>/<prefix>` so two endpoints sharing a
 * bucket name (R2/MinIO/COS each have their own namespace) no longer collide and
 * silently overwrite each other's peer row (and stale cursor). Rewrites all three
 * places the key is referenced — the peers row, its storage_cursors, and any
 * blob_policy.fullNodes anchor pointing at the bucket.
 *
 * Key derivation goes through the shared `storageUrl` (storage-url.ts) so every
 * producer — CLI/server, the WebUI worker, and this migration — agrees byte for
 * byte; otherwise a producer still minting the legacy shape turns the rename into
 * a permanent whack-a-mole.
 *
 * Idempotent — a row already at its endpoint-qualified key produces no rename.
 * Keyed off config.endpoint (authoritative), so re-running is a no-op.
 *
 * Cross-version note: rewriting blob_policy.fullNodes is a CRDT write, so it
 * replicates. A device still on the old code keeps a legacy-format storage peer
 * and matches anchors by exact string, so it won't recognize the new-format
 * anchor until it upgrades — during that window a bucket-anchored device pauses
 * cache eviction (loss-free: bytes stay, nothing is dropped) and self-heals once
 * the fleet is upgraded. Only affects setups that designate a bucket as a
 * full-blob anchor. (Accepted over a tolerant-matcher rewrite, which is wider and
 * still can't fix already-shipped old clients.)
 */
export function migrateStoragePeerUrls(db: DbDriver): void {
  if (!tableExists(db, "peers")) return;
  const rows = db
    .query("SELECT url, config FROM peers WHERE kind = 's3' AND config IS NOT NULL")
    .all() as { url: string; config: string }[];
  if (rows.length === 0) return;

  const renames: { oldUrl: string; newUrl: string }[] = [];
  const claimed = new Set<string>(); // newUrls taken this batch — avoid two→one
  for (const r of rows) {
    let cfg: { endpoint?: string; bucket?: string; prefix?: string };
    try {
      cfg = JSON.parse(r.config);
    } catch {
      continue; // malformed config — leave the row untouched
    }
    if (!cfg.endpoint || !cfg.bucket || !cfg.prefix) continue;
    const newUrl = storageUrl(cfg.endpoint, cfg.bucket, cfg.prefix);
    if (newUrl === r.url) {
      claimed.add(newUrl); // already canonical — reserve so nothing renames onto it
      continue;
    }
    // Skip if the target key is already occupied — by an existing peers row, an
    // existing storage_cursors row (composite PK would throw), or another row in
    // this same batch. A throwing migration would make the DB fail to open; the
    // legacy row is left as-is instead (collisions are vanishingly rare).
    if (
      claimed.has(newUrl) ||
      db.query("SELECT 1 FROM peers WHERE url = ?").get(newUrl) ||
      (tableExists(db, "storage_cursors") &&
        db.query("SELECT 1 FROM storage_cursors WHERE peer_url = ?").get(newUrl))
    ) {
      continue;
    }
    claimed.add(newUrl);
    renames.push({ oldUrl: r.url, newUrl });
  }
  if (renames.length === 0) return;

  const map = new Map(renames.map(({ oldUrl, newUrl }) => [oldUrl, newUrl]));
  const tx = db.transaction(() => {
    for (const { oldUrl, newUrl } of renames) {
      if (tableExists(db, "storage_cursors"))
        db.query("UPDATE storage_cursors SET peer_url = ? WHERE peer_url = ?").run(newUrl, oldUrl);
      db.query("UPDATE peers SET url = ? WHERE url = ?").run(newUrl, oldUrl);
    }
    // Rewrite synced anchor references (CRDT-backed, so this replicates). See the
    // cross-version note above.
    if (tableExists(db, "blob_policy")) {
      const fullNodes = readPolicy(db).fullNodes;
      if (fullNodes.some((n) => map.has(n)))
        setFullNodes(db, fullNodes.map((n) => map.get(n) ?? n));
    }
  });
  tx();
}

/**
 * Add the generic `meta` JSON column to a legacy `databases` table.
 * Idempotent — guarded by hasColumn.
 *
 * Re-materialization: an OLD binary that pulled `databases/meta` changes from
 * newer peers stored them in crdt_changes (applyChange inserts before the
 * column check) but skipped materialization (unknown column, forward-compat)
 * and advanced the pull cursor past them — they would never replay on their
 * own. When the column is first added, backfill each database's meta from its
 * WINNING oplog change (max HLC — the same LWW rule applyChange uses), so an
 * upgrade sees the state its peers already agreed on.
 */
export function migrateDatabases(db: DbDriver): void {
  if (hasColumn(db, "databases", "meta")) return;
  db.exec("ALTER TABLE databases ADD COLUMN meta TEXT");
  db.exec(`
    UPDATE databases SET meta = (
      SELECT c.value FROM crdt_changes c
      WHERE c.dataset = 'databases' AND c.col = 'meta' AND c.row_id = databases.id
      ORDER BY c.hlc DESC LIMIT 1
    )
    WHERE id IN (
      SELECT DISTINCT row_id FROM crdt_changes WHERE dataset = 'databases' AND col = 'meta'
    )
  `);
}

/**
 * Add the `visibility` / `spa` / `public_grants` access columns to a legacy
 * `sites` table. Idempotent — guarded per column.
 *
 * Re-materialization (same pattern as migrateDatabases): an OLD binary that
 * pulled `sites/visibility|spa` changes from newer peers stored them in
 * crdt_changes but skipped materialization (unknown column, forward-compat)
 * and advanced its cursors past them. When a column is first added, backfill
 * each site from its WINNING oplog change (max HLC — the LWW rule applyChange
 * uses). Unlike databases.meta (a JSON-text column, where the raw change value
 * is the stored form), these columns store scalars, so the JSON-encoded oplog
 * value is unwrapped with json_extract (`"public"` → public, `1` → 1).
 */
export function migrateSitesAccess(db: DbDriver): void {
  const backfill = (col: string, fallback: string) => {
    db.exec(`
      UPDATE sites SET ${col} = COALESCE((
        SELECT json_extract(c.value, '$') FROM crdt_changes c
        WHERE c.dataset = 'sites' AND c.col = '${col}' AND c.row_id = sites.id
        ORDER BY c.hlc DESC LIMIT 1
      ), ${fallback})
      WHERE id IN (
        SELECT DISTINCT row_id FROM crdt_changes WHERE dataset = 'sites' AND col = '${col}'
      )
    `);
  };
  if (!hasColumn(db, "sites", "visibility")) {
    db.exec("ALTER TABLE sites ADD COLUMN visibility TEXT");
    backfill("visibility", "NULL");
  }
  if (!hasColumn(db, "sites", "spa")) {
    // COALESCE fallback 0: the column is NOT NULL, and a peer may have synced
    // an explicit null register.
    db.exec("ALTER TABLE sites ADD COLUMN spa INTEGER NOT NULL DEFAULT 0");
    backfill("spa", "0");
  }
  if (!hasColumn(db, "sites", "public_grants")) {
    // Same oplog re-materialization as visibility: the winning change's value is
    // a JSON-encoded string (the serialized GrantSet), unwrapped by json_extract.
    // Junk survives the backfill harmlessly — every reader goes through
    // parseGrantSet's default-deny.
    db.exec("ALTER TABLE sites ADD COLUMN public_grants TEXT");
    backfill("public_grants", "NULL");
  }
}

/** Bring a freshly opened (or legacy) database to the current schema. */
export function initSchema(db: DbDriver): void {
  runSchema(db);
  migrateOplog(db);
  migrateDatabases(db);
  migrateCrdtChangesSeq(db);
  migrateRecords(db);
  migratePeers(db);
  migrateStoragePeerUrls(db);
  migrateDocBlocks(db);
  migrateDocuments(db);
  migrateBlobCache(db);
  migrateShares(db);
  migrateSitesAccess(db);
}
