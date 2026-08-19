import type { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { changesAfterSeq, ingest, type Change } from "./crdt.ts";
import { ftsAvailable } from "./schema-init.ts";
import { ensurePropIndex } from "./indexing.ts";
import { repairHub } from "./integrity.ts";
import { cacheDir, metahubHome } from "./paths.ts";
import { blobPath } from "./cache.ts";
import { MhError } from "./errors.ts";

export const SNAPSHOT_FORMAT = "metahub-snapshot";
export const SNAPSHOT_VERSION = 1;

export interface PeerRow {
  url: string;
  pull_cursor: number;
  push_cursor: number;
}

export interface SnapshotPackage {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  createdAt: string;
  source: { node_id: string | null; hlc: string | null };
  counts: { changes: number; blobs: number };
  meta: { node_id: string | null; hlc: string | null };
  peers: PeerRow[];
  changes: Change[];
  // hash (sha256, also the cache filename) -> base64-encoded bytes
  blobs: Record<string, string>;
}

function readMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

async function readBlobs(): Promise<Record<string, string>> {
  const dir = cacheDir();
  if (!existsSync(dir)) return {};
  const blobs: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const bytes = new Uint8Array(await Bun.file(blobPath(name)).arrayBuffer());
    blobs[name] = Buffer.from(bytes).toString("base64");
  }
  return blobs;
}

/** Capture the whole hub (oplog + identity + peers + blobs) into a portable package. */
export async function createSnapshot(db: Database): Promise<SnapshotPackage> {
  const changes = changesAfterSeq(db, 0).changes;
  const node_id = readMeta(db, "node_id");
  const hlc = readMeta(db, "hlc");
  const peers = db
    .query("SELECT url, pull_cursor, push_cursor FROM peers")
    .all() as PeerRow[];
  const blobs = await readBlobs();

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    source: { node_id, hlc },
    counts: { changes: changes.length, blobs: Object.keys(blobs).length },
    meta: { node_id, hlc },
    peers,
    changes,
    blobs,
  };
}

export interface WriteResult {
  counts: SnapshotPackage["counts"];
  bytes: number;
}

/** Serialize a package to a gzip-compressed JSON file. */
export async function writeSnapshot(
  pkg: SnapshotPackage,
  path: string,
): Promise<WriteResult> {
  const gz = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(pkg)));
  await Bun.write(path, gz);
  return { counts: pkg.counts, bytes: gz.byteLength };
}

/** Read and validate a package file written by writeSnapshot. */
export async function readSnapshot(path: string): Promise<SnapshotPackage> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new MhError("not_found", `no such package: ${path}`);
  const json = new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await file.arrayBuffer())),
  );
  let pkg: SnapshotPackage;
  try {
    pkg = JSON.parse(json) as SnapshotPackage;
  } catch {
    throw new MhError("invalid_input", `not a valid metahub package: ${path}`);
  }
  if (pkg.format !== SNAPSHOT_FORMAT)
    throw new MhError("invalid_input", `not a metahub snapshot package: ${path}`);
  if (pkg.version !== SNAPSHOT_VERSION)
    throw new MhError("invalid_input", `unsupported snapshot version: ${pkg.version}`);
  return pkg;
}

async function writeBlobs(blobs: Record<string, string>): Promise<number> {
  let n = 0;
  for (const [hash, b64] of Object.entries(blobs)) {
    const path = blobPath(hash);
    if (!(await Bun.file(path).exists()))
      await Bun.write(path, Buffer.from(b64, "base64"));
    n++;
  }
  return n;
}

/**
 * Indexes are derived (not in the oplog), so replaying changes doesn't recreate
 * them. Rebuild the declared ones (relation/doc fields + explicit indexed hint);
 * auto-indexes from query usage re-derive lazily on next query.
 */
function rebuildDeclaredIndexes(db: Database): void {
  const props = db
    .query(
      "SELECT id, database_id, type, config FROM properties WHERE __deleted = 0",
    )
    .all() as {
    id: string;
    database_id: string | null;
    type: string;
    config: string | null;
  }[];
  for (const p of props) {
    if (!p.database_id) continue;
    const indexed = p.config ? (JSON.parse(p.config) as { indexed?: boolean }).indexed : false;
    if (p.type === "relation" || p.type === "doc" || indexed) ensurePropIndex(db, p.database_id, p.id);
  }
}

export interface RestoreResult {
  mode: "merge" | "reset";
  applied: number;
  blobs: number;
  /** Repair changes emitted to fix invariants broken by the merged/restored data. */
  repaired: number;
  safetyPath?: string;
}

/**
 * Apply a package to the local hub.
 * - merge (default): replay the package's oplog via ingest(); idempotent,
 *   last-writer-wins by HLC. Local identity/peers untouched.
 * - reset: wipe and rebuild to match the package exactly. Destructive, so it
 *   first saves a safety snapshot of current state. Orphan blobs from the old
 *   state are left in cache/ (content-addressed, harmless).
 */
export async function restoreSnapshot(
  db: Database,
  pkg: SnapshotPackage,
  opts: { reset?: boolean; force?: boolean } = {},
): Promise<RestoreResult> {
  if (!opts.reset) {
    const applied = ingest(db, pkg.changes);
    rebuildDeclaredIndexes(db);
    // Merging a peer's oplog can break invariants (e.g. a record created here
    // into a database deleted there). Deterministic repair reconciles them.
    const repaired = repairHub(db).applied;
    const blobs = await writeBlobs(pkg.blobs);
    return { mode: "merge", applied, blobs, repaired };
  }

  if (!opts.force)
    throw new MhError(
      "invalid_input",
      "refusing to replace local data without --force (a safety snapshot is saved first)",
    );

  const safetyPath = join(metahubHome(), `.pre-restore-${Date.now()}.mhpack`);
  await writeSnapshot(await createSnapshot(db), safetyPath);

  let applied = 0;
  const tx = db.transaction(() => {
    for (const t of [
      "crdt_changes",
      "databases",
      "properties",
      "records",
      "documents",
      "doc_blocks",
      "peers",
    ])
      db.query(`DELETE FROM ${t}`).run();
    db.query("DELETE FROM meta WHERE key IN ('search_seq', 'search_index_version')").run();
    if (ftsAvailable(db)) db.query("DELETE FROM search_fts").run();

    const setMeta = db.query(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    if (pkg.meta.node_id != null) setMeta.run("node_id", pkg.meta.node_id);
    if (pkg.meta.hlc != null) setMeta.run("hlc", pkg.meta.hlc);

    applied = ingest(db, pkg.changes);

    for (const p of pkg.peers)
      db.query(
        "INSERT INTO peers (url, pull_cursor, push_cursor) VALUES (?, ?, ?)",
      ).run(p.url, p.pull_cursor, p.push_cursor);
  });
  tx();
  rebuildDeclaredIndexes(db);
  const repaired = repairHub(db).applied;

  const blobs = await writeBlobs(pkg.blobs);
  return { mode: "reset", applied, blobs, repaired, safetyPath };
}
