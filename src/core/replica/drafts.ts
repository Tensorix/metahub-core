import type { DbDriver } from "../driver.ts";

export interface DocumentDraft {
  revision: number;
  title: string;
  body: string;
  version: string | null;
}
export interface FieldDraft {
  value: unknown;
  status: "draft" | "invalid" | "pending" | "error";
  error?: string;
}

/** Recovery checkpoints belong to the local node, never the replicated oplog. */
export function createDraftStore(db: DbDriver) {
  db.exec(`CREATE TABLE IF NOT EXISTS replica_document_drafts (
    doc_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL, version TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replica_field_drafts (
    record_id TEXT NOT NULL, prop_id TEXT NOT NULL, value TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(record_id, prop_id)
  );`);
  return {
    readDocument(docId: string): DocumentDraft | null {
      return db.query("SELECT revision, title, body, version FROM replica_document_drafts WHERE doc_id = ?").get(docId) as DocumentDraft | null;
    },
    checkpointDocument(docId: string, draft: DocumentDraft): void {
      if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) throw new Error("invalid draft revision");
      db.query(`INSERT INTO replica_document_drafts (doc_id, revision, title, body, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET
        revision=excluded.revision, title=excluded.title, body=excluded.body,
        version=excluded.version, updated_at=excluded.updated_at
        WHERE excluded.revision >= replica_document_drafts.revision`)
        .run(docId, draft.revision, draft.title, draft.body, draft.version, Date.now());
    },
    acknowledgeDocument(docId: string, revision: number, _version?: string): void {
      db.query("DELETE FROM replica_document_drafts WHERE doc_id = ? AND revision <= ?").run(docId, revision);
    },
    readFields(recordId: string): Record<string, FieldDraft> {
      const rows = db.query("SELECT prop_id, value, status, error FROM replica_field_drafts WHERE record_id = ?").all(recordId) as { prop_id: string; value: string; status: FieldDraft["status"]; error: string | null }[];
      return Object.fromEntries(rows.map(r => [r.prop_id, { value: JSON.parse(r.value), status: r.status, ...(r.error ? { error: r.error } : {}) }]));
    },
    checkpointField(recordId: string, propId: string, draft: FieldDraft): void {
      db.query(`INSERT INTO replica_field_drafts (record_id, prop_id, value, status, error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(record_id, prop_id) DO UPDATE SET
        value=excluded.value, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`)
        .run(recordId, propId, JSON.stringify(draft.value ?? null), draft.status, draft.error ?? null, Date.now());
    },
    acknowledgeField(recordId: string, propId: string, expectedValue: unknown): void {
      // Conditional acknowledgement cannot remove a newer edit of this field.
      db.query("DELETE FROM replica_field_drafts WHERE record_id = ? AND prop_id = ? AND value = ?")
        .run(recordId, propId, JSON.stringify(expectedValue ?? null));
    },
    discardRecord(recordId: string): void {
      db.query("DELETE FROM replica_field_drafts WHERE record_id = ?").run(recordId);
    },
  };
}
export type ReplicaDraftStore = ReturnType<typeof createDraftStore>;
