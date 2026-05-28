import type { Database } from "bun:sqlite";
import { makeId } from "./ids.ts";
import { emit } from "./crdt.ts";

export interface DocumentRow {
  id: string;
  title: string;
  body: string | null;
  database_id: string | null;
  parent_id: string | null;
  created_hlc: string;
}

export type DocumentSummary = Omit<DocumentRow, "body">;

export function createDocument(
  db: Database,
  opts: { title: string; body?: string; database_id?: string; parent_id?: string },
): DocumentRow {
  const id = makeId(opts.title, "doc");
  const first = emit(db, "documents", id, "title", opts.title);
  emit(db, "documents", id, "created_hlc", first.hlc);
  if (opts.body !== undefined) emit(db, "documents", id, "body", opts.body);
  if (opts.database_id !== undefined) emit(db, "documents", id, "database_id", opts.database_id);
  if (opts.parent_id !== undefined) emit(db, "documents", id, "parent_id", opts.parent_id);
  return getDocument(db, id)!;
}

export function getDocument(db: Database, id: string): DocumentRow | null {
  return db
    .query(
      "SELECT id, title, body, database_id, parent_id, created_hlc FROM documents WHERE id = ? AND __deleted = 0",
    )
    .get(id) as DocumentRow | null;
}

export function listDocuments(
  db: Database,
  opts: { database_id?: string } = {},
): DocumentSummary[] {
  if (opts.database_id)
    return db
      .query(
        "SELECT id, title, database_id, parent_id, created_hlc FROM documents WHERE database_id = ? AND __deleted = 0 ORDER BY created_hlc",
      )
      .all(opts.database_id) as DocumentSummary[];
  return db
    .query(
      "SELECT id, title, database_id, parent_id, created_hlc FROM documents WHERE __deleted = 0 ORDER BY created_hlc",
    )
    .all() as DocumentSummary[];
}

export function updateDocument(
  db: Database,
  id: string,
  fields: { title?: string; body?: string; database_id?: string; parent_id?: string },
): DocumentRow {
  if (!getDocument(db, id)) throw new Error(`no such document: ${id}`);
  if (fields.title !== undefined) emit(db, "documents", id, "title", fields.title);
  if (fields.body !== undefined) emit(db, "documents", id, "body", fields.body);
  if (fields.database_id !== undefined) emit(db, "documents", id, "database_id", fields.database_id);
  if (fields.parent_id !== undefined) emit(db, "documents", id, "parent_id", fields.parent_id);
  return getDocument(db, id)!;
}

export function deleteDocument(db: Database, id: string): boolean {
  if (!getDocument(db, id)) return false;
  emit(db, "documents", id, "__deleted", 1);
  return true;
}
