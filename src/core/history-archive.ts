import { observeHistory, historyChangeKey } from "./sync/history-observation.ts";
import { decodeUtf8 } from "./sync/portable-json.ts";
import { z } from "zod";
import type { DbDriver } from "./driver.ts";
import { writeTx } from "./driver.ts";
import { CHANGE_SELECT, type Change } from "./crdt.ts";
import { ChangeSchema } from "./sync/protocol.ts";
import { invalidateHistory } from "./history-cache.ts";
import { MhError } from "./errors.ts";
import type { StorageClient } from "./sync/storage.ts";
import { encryptBytes, decryptBytes } from "./sync/e2ee.ts";
import { commitHash } from "./sync/commit-log.ts";

export const DocumentArchiveSchema = z.object({
  format: z.literal("metahub-document-history"), version: z.literal(1),
  workspaceId: z.string().min(1), documentId: z.string().min(1),
  // Null explicitly means the archive has collected changes, not certified
  // continuous coverage. A snapshot-only replica must never invent coverage.
  coveredFrom: z.string().nullable(), coveredThrough: z.string().nullable(),
  changes: z.array(ChangeSchema),
  observedAt: z.array(z.number().int().nonnegative().safe().nullable()).optional(),
}).strict().refine(value => !value.observedAt || value.observedAt.length === value.changes.length, "history observation count mismatch");
export type DocumentArchive = z.infer<typeof DocumentArchiveSchema>;
export interface HistoryArchiveRef { key: string; hash: string; bytes: number; documentId: string }

export function historySource(db: DbDriver): string {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_history_changes'").get();
  return exists ? `(SELECT ${CHANGE_SELECT} FROM crdt_changes UNION SELECT ${CHANGE_SELECT} FROM document_history_changes)` : "crdt_changes";
}
export function captureDocumentArchive(db: DbDriver, workspaceId: string, documentId: string): DocumentArchive {
  const source = historySource(db);
  const changes = db.query(`SELECT ${CHANGE_SELECT} FROM ${source} WHERE
    (dataset='documents' AND row_id=?) OR (dataset='doc_blocks' AND row_id IN
    (SELECT row_id FROM ${source} WHERE dataset='doc_blocks' AND col='doc_id' AND value=?)) ORDER BY hlc,row_id,col`)
    .all(documentId, JSON.stringify(documentId)) as Change[];
  if (!changes.length) throw new MhError("history_unavailable", "no collected document history");
  const observed = new Map<string, number>();
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_history_observations'").get()) {
    const rows = db.query(`SELECT * FROM sync_history_observations WHERE
      (dataset='documents' AND row_id=?) OR (dataset='doc_blocks' AND row_id IN
      (SELECT row_id FROM ${source} WHERE dataset='doc_blocks' AND col='doc_id' AND value=?))`).all(documentId,JSON.stringify(documentId)) as (Change & { at: number })[];
    for (const row of rows) observed.set(historyChangeKey(row), row.at);
  }
  return { format: "metahub-document-history", version: 1, workspaceId, documentId, coveredFrom: null, coveredThrough: null, changes,
    observedAt: changes.map(c => observed.get(historyChangeKey(c)) ?? null) };
}
export function installDocumentArchive(db: DbDriver, input: unknown, workspaceId: string): void {
  const archive = DocumentArchiveSchema.parse(input);
  if (archive.workspaceId !== workspaceId) throw new MhError("invalid_input", "history workspace mismatch");
  const blocks = new Set(archive.changes.filter(c => c.dataset === "doc_blocks" && c.col === "doc_id" && c.value === JSON.stringify(archive.documentId)).map(c => c.row_id));
  for (const c of archive.changes) {
    if (!(c.dataset === "documents" && c.row_id === archive.documentId) && !(c.dataset === "doc_blocks" && blocks.has(c.row_id)))
      throw new MhError("invalid_input", "archive contains unrelated entity changes");
  }
  writeTx(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS document_history_changes (
      hlc TEXT NOT NULL, node_id TEXT NOT NULL, dataset TEXT NOT NULL, row_id TEXT NOT NULL,
      col TEXT NOT NULL, value TEXT, txn TEXT, PRIMARY KEY(dataset,row_id,col,hlc));
      CREATE INDEX IF NOT EXISTS document_history_row ON document_history_changes(dataset,row_id,hlc)`);
    const insert = db.query("INSERT OR IGNORE INTO document_history_changes (hlc,node_id,dataset,row_id,col,value,txn) VALUES (?,?,?,?,?,?,?)");
    for (let i = 0; i < archive.changes.length; i++) {
      const c = archive.changes[i]!;
      const existing = db.query(`SELECT value,node_id,txn FROM ${historySource(db)} WHERE dataset=? AND row_id=? AND col=? AND hlc=?`).all(c.dataset,c.row_id,c.col,c.hlc) as Pick<Change, "value" | "node_id" | "txn">[];
      if (existing.some(old => old.value !== c.value || old.node_id !== c.node_id || (old.txn ?? null) !== (c.txn ?? null)))
        throw new MhError("invalid_input", "conflicting history change identity");
      insert.run(c.hlc,c.node_id,c.dataset,c.row_id,c.col,c.value,c.txn ?? null);
      const at = archive.observedAt?.[i];
      if (at != null) observeHistory(db, [c], at);
    }
  });
  invalidateHistory(db);
}
/** Publish immutable encrypted history and verify a read-back before returning
 * a reference that a checkpoint may use. No source data is deleted here. */
export async function publishDocumentArchive(client: StorageClient, prefix: string, masterKey: Uint8Array, archive: DocumentArchive): Promise<HistoryArchiveRef> {
  const parsed = DocumentArchiveSchema.parse(archive);
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed));
  if (plaintext.length > 64 * 1024 * 1024 - 28) throw new MhError("invalid_input", "history archive requires chunking");
  const bytes = await encryptBytes(masterKey, plaintext);
  const hash = await commitHash(bytes), key = `${prefix}/history/${hash}.archive`;
  await client.put(key, bytes);
  const stored = await client.get(key, { maxBytes: bytes.length });
  if (!stored || await commitHash(stored) !== hash) throw new MhError("network", "history read-back verification failed");
  return { key, hash, bytes: bytes.length, documentId: archive.documentId };
}
export async function fetchDocumentArchive(client: StorageClient, masterKey: Uint8Array, ref: HistoryArchiveRef, workspaceId: string): Promise<DocumentArchive> {
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > 64 * 1024 * 1024)
    throw new MhError("invalid_input", "invalid history archive size");
  const bytes = await client.get(ref.key, { maxBytes: ref.bytes });
  if (!bytes) throw new MhError("history_unavailable", "history is not available from storage");
  if (bytes.length !== ref.bytes || await commitHash(bytes) !== ref.hash) throw new MhError("invalid_input", "history archive integrity check failed");
  const archive = DocumentArchiveSchema.parse(JSON.parse(decodeUtf8(await decryptBytes(masterKey, bytes))));
  if (archive.workspaceId !== workspaceId || archive.documentId !== ref.documentId) throw new MhError("invalid_input", "history archive identity mismatch");
  return archive;
}

/** Bound ordinary history downloads independently of total document history.
 * Each part includes the ownership registers needed to validate its blocks.
 * One indivisible register may exceed the target; the transport's hard limit
 * still rejects an oversized individual value before publication. */
export function splitDocumentArchive(archive: DocumentArchive, targetBytes = 1024 * 1024): DocumentArchive[] {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 256) throw new MhError("invalid_input", "invalid history chunk target");
  const ownership = new Map<string, number>();
  archive.changes.forEach((c,i) => { if (c.dataset === "doc_blocks" && c.col === "doc_id" && c.value === JSON.stringify(archive.documentId)) ownership.set(c.row_id,i); });
  const encoder = new TextEncoder(), parts: DocumentArchive[] = [];
  let indices = new Set<number>(), size = 256;
  const emit = () => {
    if (!indices.size) return;
    const order = [...indices].sort((a,b) => a-b);
    parts.push({ ...archive, changes: order.map(i => archive.changes[i]!), observedAt: order.map(i => archive.observedAt?.[i] ?? null) });
    indices = new Set(); size = 256;
  };
  const bytes = archive.changes.map(c => encoder.encode(JSON.stringify(c)).length + 24);
  for (let i = 0; i < archive.changes.length; i++) {
    const c = archive.changes[i]!, owner = c.dataset === "doc_blocks" ? ownership.get(c.row_id) : undefined;
    if (c.dataset === "doc_blocks" && owner === undefined) throw new MhError("invalid_input", "history block has no ownership record");
    let needed = [i, ...(owner === undefined || owner === i ? [] : [owner])].filter(index => !indices.has(index));
    if (indices.size && size + needed.reduce((sum,index) => sum + bytes[index]!,0) > targetBytes) {
      emit(); needed = [i, ...(owner === undefined || owner === i ? [] : [owner])];
    }
    for (const index of needed) { indices.add(index); size += bytes[index]!; }
  }
  emit();
  return parts.length ? parts : [archive];
}
