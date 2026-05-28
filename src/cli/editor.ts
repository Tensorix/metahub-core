import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomSuffix } from "../core/ids.ts";
import { getDocument, updateDocument } from "../core/documents.ts";
import { getRecord, updateRecord } from "../core/records.ts";

/** Open `initial` in $EDITOR, return the saved contents. */
async function editInEditor(initial: string, ext: string): Promise<string> {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const file = join(tmpdir(), `metahub-${randomSuffix(8)}.${ext}`);
  await Bun.write(file, initial);
  try {
    const proc = Bun.spawn([...editor.split(" "), file], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return await Bun.file(file).text();
  } finally {
    await rm(file, { force: true });
  }
}

/** Parse a `Name: <json>` form back into a data object. */
function parseForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (!key) continue;
    if (raw === "") {
      out[key] = null;
      continue;
    }
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export interface EditResult {
  type: "document" | "record";
  id: string;
  changed: boolean;
}

/** Edit a document (markdown body) or record (field form) in $EDITOR. */
export async function runEdit(db: Database, id: string): Promise<EditResult> {
  const doc = getDocument(db, id);
  if (doc) {
    const before = doc.body ?? "";
    const after = await editInEditor(before, "md");
    const changed = after !== before;
    if (changed) updateDocument(db, id, { body: after });
    return { type: "document", id, changed };
  }

  const rec = getRecord(db, id);
  if (rec) {
    const before = Object.entries(rec.values)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    const after = await editInEditor(`${before}\n`, "txt");
    const changed = after.trim() !== before.trim();
    if (changed) updateRecord(db, id, parseForm(after));
    return { type: "record", id, changed };
  }

  throw new Error(`no such document or record: ${id}`);
}
