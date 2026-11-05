import type { DbDriver } from "../driver.ts";
import type { Change } from "../crdt.ts";
import { documentVersion, editDocumentBlocks, getDocument, type BlockEdit } from "../documents.ts";

/** Replay plain block edits only when every edited register still has the
 * exact common baseline. Structural edits or missing evidence stay recoverable
 * copies. Unedited remote blocks are preserved. */
export function restoreUncontestedText(source: DbDriver, target: DbDriver, docId: string, pending: Change[]): boolean {
  if (!getDocument(target, docId)) return false;
  const relevant = pending.filter(c => c.dataset === "doc_blocks" &&
    !!source.query("SELECT 1 FROM doc_blocks WHERE id=? AND doc_id=?").get(c.row_id, docId));
  if (!relevant.length || relevant.some(c => c.col !== "text")) return false;
  if (pending.some(c => c.dataset === "documents" && c.row_id === docId && !["body", "updated_at"].includes(c.col))) return false;
  const groups = new Map<string, Change[]>();
  for (const change of relevant) groups.set(change.row_id, [...(groups.get(change.row_id) ?? []), change]);
  const edits: BlockEdit[] = [];
  for (const [id, changes] of groups) {
    changes.sort((a,b) => a.hlc.localeCompare(b.hlc));
    const first = changes[0]!, last = changes.at(-1)!;
    if (!target.query("SELECT 1 FROM doc_blocks WHERE id=? AND doc_id=? AND __deleted=0").get(id, docId)) return false;
    const current = target.query("SELECT hlc,value FROM crdt_changes WHERE dataset='doc_blocks' AND row_id=? AND col='text' ORDER BY hlc DESC LIMIT 1").get(id) as { hlc: string; value: string | null } | null;
    if (current?.value === last.value) continue;
    const base = source.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_base:${first.hlc}:doc_blocks:${id}:text`) as { value: string } | null;
    if (!base || !current || current.hlc !== JSON.parse(base.value)) return false;
    const text: unknown = last.value === null ? null : JSON.parse(last.value);
    if (typeof text !== "string" || !text) return false;
    edits.push({ type: "update", id, text });
  }
  if (edits.length) editDocumentBlocks(target, docId, edits, { ifMatch: documentVersion(target, docId) });
  return true;
}
