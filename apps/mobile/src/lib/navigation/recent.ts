import type { DbDriver } from "../../../../../src/core/driver.ts";
export interface RecentItem {
  id: string;
  kind: "document" | "record" | "database" | "site";
  title: string;
  openedAt: number;
}
const events = new Map<string, Set<() => void>>();
/** Device-local summaries only. No CRDT writes or credentials. */
export function createRecentStore(db: DbDriver, workspaceId: string) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS mobile_recent (workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, opened_at INTEGER NOT NULL, PRIMARY KEY(workspace,kind,id))",
  );
  const emit = () => {
    for (const cb of events.get(workspaceId) ?? []) {
      try {
        cb();
      } catch {
        /* One observer cannot interrupt another save. */
      }
    }
  };
  return {
    read(): RecentItem[] {
      return db
        .query(
          "SELECT id,kind,title,opened_at AS openedAt FROM mobile_recent WHERE workspace=? ORDER BY opened_at DESC,kind,id",
        )
        .all(workspaceId) as RecentItem[];
    },
    remember(item: Omit<RecentItem, "openedAt">) {
      db.transaction(() => {
        const previous = db
          .query(
            "SELECT MAX(opened_at) AS at FROM mobile_recent WHERE workspace=?",
          )
          .get(workspaceId) as { at: number | null };
        const openedAt = Math.max(Date.now(), (previous.at ?? 0) + 1);
        db.query(
          "INSERT INTO mobile_recent(workspace,kind,id,title,opened_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace,kind,id) DO UPDATE SET title=excluded.title,opened_at=excluded.opened_at",
        ).run(
          workspaceId,
          item.kind,
          item.id,
          item.title.slice(0, 500),
          openedAt,
        );
        db.query(
          "DELETE FROM mobile_recent WHERE workspace=? AND kind=? AND rowid NOT IN (SELECT rowid FROM mobile_recent WHERE workspace=? AND kind=? ORDER BY opened_at DESC,kind,id LIMIT 50)",
        ).run(workspaceId, item.kind, workspaceId, item.kind);
      })();
      emit();
    },
    forget(kind: RecentItem["kind"], id: string) {
      db.query(
        "DELETE FROM mobile_recent WHERE workspace=? AND kind=? AND id=?",
      ).run(workspaceId, kind, id);
      emit();
    },
    /** Undo removal without bumping visit time or replacing a newer visit. */
    restore(item: RecentItem) {
      db.query("INSERT OR IGNORE INTO mobile_recent(workspace,kind,id,title,opened_at) VALUES(?,?,?,?,?)")
        .run(workspaceId, item.kind, item.id, item.title, item.openedAt);
      emit();
    },
    subscribe(cb: () => void) {
      let listeners = events.get(workspaceId);
      if (!listeners) {
        listeners = new Set();
        events.set(workspaceId, listeners);
      }
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (!listeners.size) events.delete(workspaceId);
      };
    },
  };
}
