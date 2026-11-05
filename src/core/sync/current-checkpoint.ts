import { documentVersion } from "../documents.ts";
import { z } from "zod";
import type { DbDriver } from "../driver.ts";
import { writeTx } from "../driver.ts";
import { CHANGE_SELECT, type Change, ingestDetailed } from "../crdt.ts";
import { ChangeSchema } from "./protocol.ts";
import { MhError } from "../errors.ts";
import { invalidateHistory } from "../history-cache.ts";

const DeletedBlockSchema = z.object({ id: z.string(), documentId: z.string().nullable(), confirmedAt: z.number().int().nonnegative().safe().optional() }).strict();
export const CurrentCheckpointSchema = z.object({
  format: z.literal("metahub-current"), protocolVersion: z.literal(2),
  workspaceId: z.string().min(1), epoch: z.number().int().nonnegative().safe(),
  pendingRecovery: z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), local: z.string(), remote: z.string().nullable(), status: z.string(), result: z.string().nullable() }).strict()).default([]),
  managedDocuments: z.array(z.string()).default([]),
  documentVersions: z.record(z.string(), z.string()).default({}),
  history: z.array(z.object({ documentId: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default([]),
  coveredSequence: z.number().int().nonnegative().safe().default(0),
  sourceCoverage: z.record(z.string(), z.number().int().nonnegative().safe()).default({}),
  changes: z.array(ChangeSchema), deletedBlocks: z.array(DeletedBlockSchema),
}).strict();
export type CurrentCheckpoint = z.infer<typeof CurrentCheckpointSchema>;

/** Projection only. Never removes source oplog/history. Deleted bodies are not
 * part of the current-state baseline; deletion identity remains explicit. */
export function captureCurrentCheckpoint(db: DbDriver, workspaceId: string, epoch: number): CurrentCheckpoint {
  return writeTx(db, () => {
    const deletedBlocks = db.query("SELECT id, doc_id AS documentId FROM doc_blocks WHERE __deleted=1 ORDER BY id").all() as { id: string; documentId: string | null }[];
    const deleted = new Set(deletedBlocks.map(b => b.id));
    const changes = (db.query(`SELECT ${CHANGE_SELECT} FROM crdt_changes c WHERE NOT EXISTS (
      SELECT 1 FROM crdt_changes k WHERE k.dataset=c.dataset AND k.row_id=c.row_id AND k.col=c.col AND k.hlc>c.hlc
    ) ORDER BY dataset,row_id,col`).all() as Change[]).filter(c => c.dataset !== "doc_blocks" || !deleted.has(c.row_id) || c.col === "__deleted" || c.col === "doc_id");
    const documents = db.query("SELECT id FROM documents ORDER BY id").all() as { id: string }[];
    const managedDocuments = documents.filter(({ id }) => db.query("SELECT 1 FROM doc_blocks WHERE doc_id=? LIMIT 1").get(id) || db.query("SELECT 1 FROM meta WHERE key=?").get(`sync_v2_managed:${id}`)).map(r => r.id);
    const documentVersions = Object.fromEntries(documents.map(({ id }) => [id, documentVersion(db, id)]));
    const pendingRecovery = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_recovery_items'").get()
      ? db.query("SELECT * FROM sync_recovery_items WHERE status='pending' ORDER BY id").all() : [];
    return CurrentCheckpointSchema.parse({ pendingRecovery, managedDocuments, documentVersions, format: "metahub-current", protocolVersion: 2, workspaceId, epoch, changes, deletedBlocks });
  });
}

/** Install only into an empty shadow database. A caller must preserve and verify
 * the old database/outbox before swapping this shadow into its live session. */
export function installCurrentCheckpoint(db: DbDriver, input: unknown, workspaceId: string): void {
  const checkpoint = CurrentCheckpointSchema.parse(input);
  if (checkpoint.workspaceId !== workspaceId) throw new MhError("invalid_input", "checkpoint workspace mismatch");
  const deleted = new Set(checkpoint.deletedBlocks.map(b => b.id));
  if (deleted.size !== checkpoint.deletedBlocks.length) throw new MhError("invalid_input", "duplicate deleted block identity");
  const registers = new Set<string>();
  for (const c of checkpoint.changes) {
    const register = JSON.stringify([c.dataset,c.row_id,c.col]);
    if (registers.has(register)) throw new MhError("invalid_input", "checkpoint contains multiple register winners");
    registers.add(register);
    if (c.dataset === "doc_blocks" && deleted.has(c.row_id) && c.col !== "__deleted" && c.col !== "doc_id")
      throw new MhError("invalid_input", "deleted content in current checkpoint");
  }
  for (const id of deleted) {
    if (!checkpoint.changes.some(c => c.dataset === "doc_blocks" && c.row_id === id && c.col === "__deleted" && c.value === "1"))
      throw new MhError("invalid_input", "deleted block has no deletion register");
  }
  writeTx(db, () => {
    if (db.query("SELECT 1 FROM crdt_changes LIMIT 1").get()) throw new MhError("conflict", "checkpoint installation requires an empty shadow database");
    for (const id of checkpoint.managedDocuments) db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(`sync_v2_managed:${id}`, "1");
    for (const [id, version] of Object.entries(checkpoint.documentVersions)) db.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)").run(`sync_v2_doc_version:${id}`, version);
    db.exec(`CREATE TABLE IF NOT EXISTS sync_recovery_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, local TEXT NOT NULL, remote TEXT, status TEXT NOT NULL DEFAULT 'pending', result TEXT)`);
    for (const item of checkpoint.pendingRecovery) db.query("INSERT OR IGNORE INTO sync_recovery_items(id,kind,target,local,remote,status,result) VALUES(?,?,?,?,?,?,?)").run(item.id,item.kind,item.target,item.local,item.remote,item.status,item.result);
    const ordered = [...checkpoint.changes].sort((a,b) => Number(b.col === "__deleted") - Number(a.col === "__deleted"));
    const result = ingestDetailed(db, ordered);
    db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("sync_v2_checkpoint", JSON.stringify({ history: checkpoint.history, coveredSequence: checkpoint.coveredSequence, sourceCoverage: checkpoint.sourceCoverage }));
    if (result.poisoned || Object.values(result.skewed).some(n => n > 0) || result.received !== ordered.length)
      throw new MhError("invalid_input", "checkpoint could not be installed completely");
    for (const id of checkpoint.managedDocuments) {
      if (!db.query("SELECT 1 FROM doc_blocks WHERE doc_id=? AND __deleted=0 LIMIT 1").get(id))
        db.query("UPDATE documents SET body='' WHERE id=?").run(id);
    }
  });
  invalidateHistory(db);
}
