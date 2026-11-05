import { SYNCED_TABLES } from "../tables.ts";
import { ClientUpdateRequired, MhError } from "../errors.ts";
import { writeTx, type DbDriver } from "../driver.ts";

export const dataVersionRange = { minSupportedDataVersion: 1, maxSupportedDataVersion: 2 } as const;
const key = "sync_workspace_data_version";
type Observation = { workspaceId: string; dataVersion: number; awaitingCompatibleClient?: boolean };

export function knownDataVersion(db: DbDriver): Observation | null {
  const row = db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null;
  if (!row) return null;
  const saved: Observation = JSON.parse(row.value);
  if (!saved || typeof saved.workspaceId !== "string" || !saved.workspaceId || !Number.isSafeInteger(saved.dataVersion) || saved.dataVersion < 2)
    throw new MhError("invalid_input", "Invalid saved workspace data version");
  return saved;
}

export function requireSupportedVersion(version: number, max = Number(dataVersionRange.maxSupportedDataVersion), min = Number(dataVersionRange.minSupportedDataVersion)) {
  if (!Number.isSafeInteger(version) || version < 1) throw new MhError("invalid_input", "Invalid workspace data version");
  if (!Number.isSafeInteger(max) || !Number.isSafeInteger(min) || min < 1 || max < min) throw new MhError("invalid_input", "Invalid supported data version");
  if (version > max) throw new ClientUpdateRequired(version, max);
  if (version < min) throw new MhError("upgrade_required", "Workspace data version requires migration");
}

export function localDataVersion(db: DbDriver) {
  return knownDataVersion(db)?.dataVersion ??
    (db.query("SELECT 1 FROM meta WHERE key='sync_v2_generation'").get() ? 2 : 1);
}

// Scope offline editing protection to first enrollment of an empty replica.
// A pre-existing offline workspace must be able to retain edits on upgrade.
export function beginVersionCheck(db: DbDriver, url: string) {
  if (knownDataVersion(db) || db.query("SELECT 1 FROM meta WHERE key IN (?, 'sync_v2_generation')").get(`sync_verified_peer:${url}`)) return;
  if (db.query("SELECT 1 FROM peers WHERE url=? AND last_success_at IS NOT NULL").get(url)) return;
  if (db.query("SELECT 1 FROM crdt_changes WHERE dataset<>'nodes' LIMIT 1").get()) return;
  db.query("INSERT OR IGNORE INTO meta(key,value) VALUES('sync_version_pending_join',?)").run(url);
}
export function finishVersionCheck(db: DbDriver, url: string) {
  writeTx(db, () => {
    if (db.query("DELETE FROM meta WHERE key='sync_version_pending_join' AND value=?").run(url).changes)
      db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?, '1')").run(`sync_verified_peer:${url}`);
  });
}
export function assertUserEditAllowed(db: DbDriver) {
  assertWorkspaceWritable(db);
  if (db.query("SELECT 1 FROM meta WHERE key='sync_version_pending_join'").get())
    throw new MhError("busy", "请先联网确认工作区版本");
}

export function assertWorkspaceWritable(db: DbDriver) {
  const saved = knownDataVersion(db);
  requireSupportedVersion(saved?.dataVersion ?? 2);
  if (saved?.awaitingCompatibleClient) throw new MhError("busy", "请先联网确认工作区版本");
}

// Called only for the bound workspace after validation of an authoritative record.
function cacheVersion(db: DbDriver, workspaceId: string, version: number) {
  if (!Number.isSafeInteger(version) || version < 2) throw new MhError("invalid_input", "Invalid workspace data version");
  writeTx(db, () => {
    const previous = knownDataVersion(db);
    if (previous && previous.workspaceId !== workspaceId) throw new MhError("conflict", "Workspace identity mismatch");
    if (previous && previous.dataVersion > version) return;
    const locked = version > dataVersionRange.maxSupportedDataVersion;
    if (previous?.dataVersion === version && !!previous.awaitingCompatibleClient === locked) return;
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(key, JSON.stringify({ workspaceId, dataVersion: version, awaitingCompatibleClient: locked }));
    // Persistent triggers also protect other open connections and direct SQL
    // maintenance. Local draft and export tables remain available.
    if (locked || previous?.awaitingCompatibleClient) {
      for (const table of [...SYNCED_TABLES, "crdt_changes"]) {
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        for (const op of ["INSERT", "UPDATE", "DELETE"]) {
          const name = `version_lock_${table}_${op}`;
          db.exec(`DROP TRIGGER IF EXISTS ${name}`);
          if (locked) db.exec(`CREATE TRIGGER ${name} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'client_update_required:${version}:${dataVersionRange.maxSupportedDataVersion}'); END`);
        }
      }
    }
  });
}

export function observeDataVersion(db: DbDriver, workspaceId: string, version: number) {
  cacheVersion(db, workspaceId, version);
  assertWorkspaceWritable(db);
}

// A previously capable binary may have written the observation. Re-establish
// its SQL lock if an older binary opens that database, before schema backfills.
export function openReadOnlyWorkspace(db: DbDriver) {
  const saved = knownDataVersion(db);
  if (!saved) return false;
  if (saved.dataVersion > dataVersionRange.maxSupportedDataVersion) {
    if (!saved.awaitingCompatibleClient) cacheVersion(db, saved.workspaceId, saved.dataVersion);
    return true;
  }
  return !!saved.awaitingCompatibleClient;
}

// One local row per editor so two windows editing the same document can both
// protect their text. These drafts never enter the synced tables or oplog.
export type VersionDraft = { editor: string; doc_id: string; title: string; body: string; version: string | null };
export function saveVersionDraft(db: DbDriver, draft: VersionDraft) {
  if ((knownDataVersion(db)?.dataVersion ?? 2) <= dataVersionRange.maxSupportedDataVersion)
    throw new MhError("conflict", "Workspace is not version locked");
  db.exec("CREATE TABLE IF NOT EXISTS sync_version_drafts(editor TEXT PRIMARY KEY, doc_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, version TEXT)");
  db.query("INSERT OR REPLACE INTO sync_version_drafts(editor,doc_id,title,body,version) VALUES(?,?,?,?,?)")
    .run(draft.editor, draft.doc_id, draft.title, draft.body, draft.version);
}
