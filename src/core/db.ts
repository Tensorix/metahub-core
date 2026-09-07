import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dbPath, cacheDir, metahubHome } from "./paths.ts";
import { initSchema } from "./schema-init.ts";
import { describeSelf, defaultForm, platformFromProcess, type NodeApp } from "./node.ts";

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
  migrateSiteChannels,
  migrateNodes,
  initSchema,
} from "./schema-init.ts";

export function ensureDirs(): void {
  mkdirSync(metahubHome(), { recursive: true });
  mkdirSync(cacheDir(), { recursive: true });
}

/** Which app opened the hub, for the synced device roster. The server sets
 *  METAHUB_APP=server before opening; the desktop shell passes desktop to its
 *  sidecar; a bare CLI invocation is cli. */
function appKind(): NodeApp {
  const v = process.env.METAHUB_APP;
  return v === "server" || v === "desktop" || v === "web" ? v : "cli";
}

/** Open (and migrate) the on-disk metahub database for the resolved home. */
export function openMetahub(): Database {
  ensureDirs();
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  initSchema(db);
  // Self-description is a no-op unless something changed (node.ts), so every
  // CLI open pays one SELECT and never dirties the oplog.
  const app = appKind();
  const platform = platformFromProcess(process.platform);
  describeSelf(db, {
    app,
    platform,
    form: defaultForm(platform, app),
    defaultLabel: safeHostname(),
  });
  return db;
}

function safeHostname(): string | null {
  try {
    const h = hostname();
    return h ? h.replace(/\.local$/i, "") : null;
  } catch {
    return null;
  }
}
