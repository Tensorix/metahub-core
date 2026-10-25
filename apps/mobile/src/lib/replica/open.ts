import { openDatabaseSync } from "expo-sqlite";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { describeSelf } from "../../../../../src/core/node.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import { ExpoDriver, nativeSqliteOpenOptions } from "./expo-driver";

/** Encode the entire identity: distinct workspaces cannot collide or escape the
 * database directory. Call initializeNativeSyncRuntime before opening on native. */
export function workspaceDatabaseName(workspaceId: string): string {
  if (!workspaceId) throw new Error("workspace identity is required");
  const encoded = Array.from(workspaceId).map(char => char.codePointAt(0)!.toString(16)).join("-");
  // Onboarding uses a compact persisted UUID as workspace identity, not a URL.
  if (encoded.length > 220) throw new Error("workspace identity must be a compact stable identifier");
  return `metahub-${encoded}.db`;
}
export function openMobileReplica(workspaceId: string, options: { platform: "ios" | "android"; label?: string }) {
  const sqlite = openDatabaseSync(workspaceDatabaseName(workspaceId), nativeSqliteOpenOptions);
  const db = new ExpoDriver(sqlite);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    initSchema(db);
    describeSelf(db, { platform: options.platform, form: "phone", defaultLabel: options.label ?? "Metahub mobile" });
    const service = createReplicaService(db, { searchBatchSize: 25 });
    let closed = false;
    return {
      db, service,
      close() {
        if (closed) return;
        closed = true;
        service.dispose();
        db.close();
      },
    };
  } catch (error) { db.close(); throw error; }
}
export type MobileReplica = ReturnType<typeof openMobileReplica>;
