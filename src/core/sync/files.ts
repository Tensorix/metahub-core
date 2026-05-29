import type { Database } from "bun:sqlite";
import { resolveEntity, type Candidate } from "../resolve.ts";
import { getDocument, updateDocument } from "../documents.ts";
import { listProperties } from "../properties.ts";
import { listRecords, getRecord, createRecord, updateRecord } from "../records.ts";
import { toCsv, parseCsv } from "../csv.ts";

export interface FileSyncResult {
  direction: "export" | "import";
  kind: "doc" | "db";
  id: string;
  path: string;
  bytes?: number; // export/import doc
  rows?: number; // export/import db
}

/**
 * Resolve a ref, distinguishing "not an entity" from "ambiguous". Returns the
 * single matching entity, `null` when nothing matches (so the caller can treat
 * the arg as a file path), and re-throws on ambiguity (so the user sees the
 * candidate list rather than a misleading "not a file" error).
 */
function tryResolve(db: Database, ref: string): Candidate | null {
  try {
    return resolveEntity(db, ref);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("ambiguous")) throw err;
    return null;
  }
}

/** Render a record cell for CSV: arrays/objects as JSON, the rest as plain text. */
function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Decode a CSV cell back to a value: JSON for array/object literals, else raw. */
function parseCell(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

async function exportDoc(db: Database, id: string, path: string): Promise<FileSyncResult> {
  const body = getDocument(db, id)!.body ?? "";
  await Bun.write(path, body);
  return { direction: "export", kind: "doc", id, path, bytes: body.length };
}

async function exportDb(db: Database, id: string, path: string): Promise<FileSyncResult> {
  const props = listProperties(db, id);
  const recs = listRecords(db, id, {});
  const header = ["id", ...props.map((p) => p.name)];
  const rows = recs.map((r) => [r.id, ...props.map((p) => cellToString(r.values[p.name]))]);
  const csv = toCsv([header, ...rows]);
  await Bun.write(path, csv);
  return { direction: "export", kind: "db", id, path, rows: recs.length };
}

async function importDoc(db: Database, id: string, path: string): Promise<FileSyncResult> {
  const body = await Bun.file(path).text();
  updateDocument(db, id, { body });
  return { direction: "import", kind: "doc", id, path, bytes: body.length };
}

async function importDb(db: Database, id: string, path: string): Promise<FileSyncResult> {
  const grid = parseCsv(await Bun.file(path).text());
  if (grid.length === 0) return { direction: "import", kind: "db", id, path, rows: 0 };
  const header = grid[0]!;
  const idCol = header.indexOf("id");
  let count = 0;
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i]!;
    const data: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      if (c === idCol) continue;
      const raw = cells[c];
      if (raw == null || raw === "") continue; // leave unset cells untouched
      data[header[c]!] = parseCell(raw);
    }
    const rowId = idCol >= 0 ? cells[idCol]?.trim() : undefined;
    if (rowId && getRecord(db, rowId)) updateRecord(db, rowId, data);
    else createRecord(db, id, data);
    count++;
  }
  return { direction: "import", kind: "db", id, path, rows: count };
}

/**
 * Move one document or data table between metahub and a file. Direction is
 * inferred: whichever of `src`/`dst` resolves to an entity is the entity, the
 * other is the file path. Entity on the left ⇒ export; on the right ⇒ import.
 * Documents map to markdown (the doc body), data tables to CSV.
 */
export async function syncFiles(db: Database, src: string, dst: string): Promise<FileSyncResult> {
  const srcEntity = tryResolve(db, src);
  const entity = srcEntity ?? tryResolve(db, dst);
  if (!entity)
    throw new Error(`neither "${src}" nor "${dst}" is a metahub document or data table`);
  if (entity.kind !== "doc" && entity.kind !== "db")
    throw new Error(`file sync supports only documents and data tables, not ${entity.kind}`);

  if (srcEntity) {
    const out = dst;
    return entity.kind === "doc"
      ? exportDoc(db, entity.id, out)
      : exportDb(db, entity.id, out);
  }
  const inFile = src;
  return entity.kind === "doc"
    ? importDoc(db, entity.id, inFile)
    : importDb(db, entity.id, inFile);
}
