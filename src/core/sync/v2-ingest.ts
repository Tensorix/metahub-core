import { MhError } from "../errors.ts";
import type { DbDriver } from "../driver.ts";
import { writeTx } from "../driver.ts";
import { ingestDetailed, type Change } from "../crdt.ts";
import type { BucketBatch } from "./bucket-v2.ts";

/** Preserve divergent same-register edits before LWW materialization. A deleted
 * block is terminal; its late text is recoverable but cannot refill current state. */
export function ingestV2Batch(db: DbDriver, batch: BucketBatch) {
  return writeTx(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, local TEXT NOT NULL,
      remote TEXT, status TEXT NOT NULL DEFAULT 'pending', result TEXT)`);
    const identities = new Map<string, Change>();
    for (const c of batch.changes) {
      const key = JSON.stringify([c.dataset,c.row_id,c.col,c.hlc]);
      const existing = identities.get(key) ?? db.query("SELECT node_id,value,txn FROM crdt_changes WHERE dataset=? AND row_id=? AND col=? AND hlc=?").get(c.dataset,c.row_id,c.col,c.hlc) as Change | null;
      if (existing && (existing.value !== c.value || existing.node_id !== c.node_id || (existing.txn ?? null) !== (c.txn ?? null)))
        throw new MhError("invalid_input", "conflicting change identity");
      identities.set(key,c);
    }
    let received = 0, poisoned = 0;
    const skewed: Record<string, number> = {};
    const known = new Set((db.query("SELECT id FROM doc_blocks").all() as { id: string }[]).map(row => row.id));
    const created = new Set(batch.changes.filter((c, i) => c.dataset === "doc_blocks" && c.col === "doc_id" && batch.bases?.[i] == null).map(c => c.row_id));
    const deleted = new Set((db.query("SELECT id FROM doc_blocks WHERE __deleted=1").all() as { id: string }[]).map(row => row.id));
    // Keep causal links before applying the batch. A replayed intermediate save
    // is an ancestor of a later local save, not an independent conflict.
    const baseKey = (c: Change, hlc: string) => `sync_v2_base:${hlc}:${c.dataset}:${c.row_id}:${c.col}`;
    for (let i = 0; i < batch.changes.length; i++) {
      const c = batch.changes[i]!, base = batch.bases?.[i];
      if (base === undefined) continue;
      if (base !== null && base >= c.hlc) throw new MhError("invalid_input", "edit baseline must precede its change");
      const previous = db.query("SELECT value FROM meta WHERE key=?").get(baseKey(c, c.hlc)) as { value: string } | null;
      if (previous && JSON.parse(previous.value) !== base) throw new MhError("invalid_input", "conflicting edit baseline");
      db.query("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(baseKey(c, c.hlc), JSON.stringify(base));
    }
    const descendsFrom = (c: Change, descendant: string, ancestor: string) => {
      let cursor: string | null = descendant;
      while (cursor && cursor >= ancestor) {
        if (cursor === ancestor) return true;
        const row = db.query("SELECT value FROM meta WHERE key=?").get(baseKey(c, cursor)) as { value: string } | null;
        if (!row) return false;
        const base: string | null = JSON.parse(row.value);
        if (base !== null && base >= cursor) return false;
        cursor = base;
      }
      return false;
    };
    const deletionVersions = new Map<string, string>();
    for (const row of db.query("SELECT row_id,MAX(hlc) AS hlc FROM crdt_changes WHERE dataset='doc_blocks' AND col='__deleted' AND value='1' GROUP BY row_id").all() as { row_id: string; hlc: string }[]) deletionVersions.set(row.row_id,row.hlc);
    for (const c of batch.changes) if (c.dataset === "doc_blocks" && c.col === "__deleted" && c.value === "1" && (deletionVersions.get(c.row_id) ?? "") < c.hlc) deletionVersions.set(c.row_id,c.hlc);
    // Deletion dominates every field in a batch independently of input order.
    for (const change of batch.changes) if (change.dataset === "doc_blocks" && change.col === "__deleted" && change.value === "1") deleted.add(change.row_id);
    for (let i = 0; i < batch.changes.length; i++) {
      const change = batch.changes[i]!;
      const current = db.query("SELECT hlc,value FROM crdt_changes WHERE dataset=? AND row_id=? AND col=? ORDER BY hlc DESC LIMIT 1")
        .get(change.dataset, change.row_id, change.col) as Pick<Change, "hlc" | "value"> | null;
      const orphan = change.dataset === "doc_blocks" && !known.has(change.row_id) && !created.has(change.row_id);
      const terminal = change.dataset === "doc_blocks" && (deleted.has(change.row_id) || orphan) && change.col !== "__deleted" && change.col !== "doc_id";
      const conflict = change.dataset === "doc_blocks" && change.col === "text" && current && current.hlc !== change.hlc && current.value !== change.value && current.hlc !== batch.bases?.[i] && !descendsFrom(change, current.hlc, change.hlc) && !descendsFrom(change, change.hlc, current.hlc);
      const deletedAt = deletionVersions.get(change.row_id);
      const deleteBaseline = deletedAt ? db.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_base:${deletedAt}:doc_blocks:${change.row_id}:__deleted`) as { value: string } | null : null;
      const observedByDelete: string | null = deleteBaseline ? JSON.parse(deleteBaseline.value) : null;
      const deliberateDeletion = terminal && observedByDelete !== null && descendsFrom(change, observedByDelete, change.hlc);
      if (change.dataset === "doc_blocks" && change.col === "__deleted" && change.value === "1") {
        const text = db.query("SELECT hlc,value FROM crdt_changes WHERE dataset='doc_blocks' AND row_id=? AND col='text' ORDER BY hlc DESC LIMIT 1").get(change.row_id) as Pick<Change,"hlc"|"value"> | null;
        if (text && (!observedByDelete || !descendsFrom({ ...change, col: "text" }, observedByDelete, text.hlc))) {
          db.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,NULL)")
            .run(`${batch.workspaceId}:${text.hlc}:${change.row_id}:text`, "block", change.row_id,
              JSON.stringify({ title: "删除与编辑冲突", body: text.value === null ? "" : JSON.parse(text.value) }));
        }
      }
      if ((terminal && change.col === "text" && !deliberateDeletion && current?.hlc !== change.hlc) || (!terminal && conflict)) {
        const decode = (value: string | null) => value === null ? "" : JSON.parse(value);
        db.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,?,?,?,?)")
          .run(`${batch.workspaceId}:${change.hlc}:${change.row_id}:${change.col}`, "block", change.row_id,
            JSON.stringify({ title: terminal ? "已删除段落的编辑" : "段落编辑冲突", body: decode(change.value) }),
            current ? JSON.stringify({ body: decode(current.value) }) : null);
      }
      if (orphan || terminal || (change.dataset === "doc_blocks" && deleted.has(change.row_id) && change.col === "__deleted" && change.value !== "1")) continue;
      const result = ingestDetailed(db, [change]);
      received += result.received; poisoned += result.poisoned ?? 0;
      for (const [node, count] of Object.entries(result.skewed)) skewed[node] = (skewed[node] ?? 0) + count;
    }
    return { received, skewed, poisoned };
  });
}
