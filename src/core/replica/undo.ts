import type { DbDriver } from "../driver";
import { deleteDocument } from "../documents";
import { deleteDatabase } from "../databases";
import { MhError } from "../errors";

/** Capture the exact synchronous delete transaction, including cascading writes.
 * Returning an undo receipt is atomic with deletion; no audit-page guessing. */
export function deleteWithUndo(
  db: DbDriver,
  kind: "document" | "database",
  id: string,
) {
  if (kind !== "document" && kind !== "database")
    throw new MhError("invalid_input", "unknown delete kind");
  return db.transaction(() => {
    const before = (
      db
        .query("SELECT coalesce(max(seq),0) AS seq FROM crdt_changes")
        .get() as { seq: number }
    ).seq;
    const ok =
      kind === "document" ? deleteDocument(db, id) : deleteDatabase(db, id);
    if (!ok) throw new MhError("not_found", "内容不存在，可能已被删除");
    const receipt = db
      .query(
        "SELECT txn FROM crdt_changes WHERE seq>? AND dataset=? AND row_id=? AND col='__deleted' ORDER BY seq DESC LIMIT 1",
      )
      .get(before, kind === "document" ? "documents" : "databases", id) as {
      txn: string | null;
    } | null;
    if (!receipt?.txn) throw new Error("无法生成删除撤销记录");
    return { ok: true, txn: receipt.txn };
  })();
}
