import type { ReplicaService } from "../../../../../src/core/replica/service";
import type { createRecentStore } from "../navigation/recent";
import { readDatabaseMenu, readDocumentMenu } from "./document-menu";

export async function deleteBrowseItem(options: {
  service: ReplicaService;
  recents: ReturnType<typeof createRecentStore>;
  kind: "document" | "database";
  id: string;
  isCurrent(): boolean;
  protect(): Promise<() => void>;
}) {
  const { service, recents, kind, id, isCurrent, protect } = options;
  const current = () => {
    if (!isCurrent()) throw new Error("工作区会话已结束");
  };
  const read = () =>
    kind === "document"
      ? readDocumentMenu(service.db, id)
      : readDatabaseMenu(service.db, id);
  const release = await protect();
  try {
    current();
    const item = read();
    if (!item) throw new Error("内容不存在，可能已被删除");
    const recordIds =
      kind === "database"
        ? (
            service.db
              .query(
                "SELECT id FROM records WHERE database_id=? AND __deleted=0",
              )
              .all(id) as { id: string }[]
          ).map((row) => row.id)
        : [];
    const documentDraft =
      kind === "document" ? service.drafts.readDocument(id) : null;
    const draftRecordIds = kind === "database" ? (service.db.query(
      "SELECT DISTINCT f.record_id AS id FROM replica_field_drafts f JOIN records r ON r.id=f.record_id WHERE r.database_id=? AND r.__deleted=0",
    ).all(id) as { id: string }[]).map(row => row.id) : [];
    const fieldDrafts = draftRecordIds.map((recordId) => ({
      id: recordId,
      fields: service.drafts.readFields(recordId),
    }));
    const recentItems = recents
      .read()
      .filter(
        (recent) =>
          (recent.kind === kind && recent.id === id) ||
          (recent.kind === "record" && recordIds.includes(recent.id)),
      );
    const receipt = await service.client.deleteWithUndo(kind, id);
    if (kind === "document") service.drafts.discardDocument(id);
    service.db.transaction(() => {
      for (const record of fieldDrafts) service.drafts.discardRecord(record.id);
    })();
    for (const recent of recentItems) recents.forget(recent.kind, recent.id);
    return {
      title: item.title || "未命名",
      async undo() {
        current();
        const unfreeze = await protect();
        try {
          current();
          const result = await service.client.undoChangeGroup(receipt.txn);
          current();
          const exists = (recordId: string) =>
            !!service.db
              .query("SELECT id FROM records WHERE id=? AND __deleted=0")
              .get(recordId);
          // New drafts/visits win over the snapshots captured by this operation.
          service.db.transaction(() => {
            if (documentDraft && read() && !service.drafts.readDocument(id))
              service.drafts.checkpointDocument(id, documentDraft);
            for (const record of fieldDrafts) {
              if (!exists(record.id)) continue;
              const newer = service.drafts.readFields(record.id);
              for (const [propertyId, draft] of Object.entries(record.fields)) {
                if (!newer[propertyId])
                  service.drafts.checkpointField(record.id, propertyId, draft);
              }
            }
          })();
          for (const recent of recentItems) {
            if (recent.kind === "record" ? exists(recent.id) : read())
              recents.restore(recent);
          }
          return result.skipped_registers || result.skipped_rows
            ? "已撤销可恢复的内容，保留了后续修改"
            : `已恢复「${item.title || "未命名"}」`;
        } finally {
          unfreeze();
        }
      },
    };
  } finally {
    release();
  }
}
