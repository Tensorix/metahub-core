import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, cacheDir, metahubHome } from "./paths.ts";
import { initSchema } from "./schema-init.ts";

// Schema bootstrap lives in schema-init.ts (runtime-agnostic, driver-typed);
// re-exported here so existing imports keep working.
export {
  runSchema,
  ftsAvailable,
  migrateRecords,
  migratePeers,
  migrateDocBlocks,
  migrateDocuments,
  migrateOplog,
  initSchema,
} from "./schema-init.ts";

export function ensureDirs(): void {
  mkdirSync(metahubHome(), { recursive: true });
  mkdirSync(cacheDir(), { recursive: true });
}

/** Open (and migrate) the on-disk metahub database for the resolved home. */
export function openMetahub(): Database {
  ensureDirs();
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  initSchema(db);
  return db;
}
