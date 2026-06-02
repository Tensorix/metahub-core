import { defineCommand } from "citty";
import type { Database } from "bun:sqlite";
import { openMetahub } from "../../core/db.ts";
import {
  createDocument,
  listDocuments,
  getDocument,
  updateDocument,
  editDocument,
  appendDocument,
  prependDocument,
  deleteDocument,
  documentVersion,
  type DocumentSummary,
} from "../../core/documents.ts";
import { resolveValue } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { print, guard } from "../output.ts";

/** Resolve a document ref (id/prefix/title) to its id. */
function docId(db: Database, ref: string): string {
  return resolveRef(db, ref, { kind: "doc" });
}

/** Render documents as an `id  tree` forest by `parent_id`, using box-drawing
 *  connectors (├──/└──/│) so parent/child and sibling boundaries read at a
 *  glance. The id sits in a space-padded fixed-width left column (ids vary a
 *  lot in length) so the tree always starts at the same column and stays
 *  aligned — a TAB here lands on uneven tab stops and skews the glyphs.
 *  Rows whose parent is absent from the set (e.g. filtered out by --db) are
 *  treated as roots so nothing is silently hidden. */
function docTree(rows: DocumentSummary[]): string {
  if (rows.length === 0) return "(empty)";
  const ids = new Set(rows.map((r) => r.id));
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const children = new Map<string, DocumentSummary[]>();
  const roots: DocumentSummary[] = [];
  for (const r of rows) {
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    if (key === null) roots.push(r);
    else (children.get(key) ?? children.set(key, []).get(key)!).push(r);
  }
  const lines: string[] = [];
  // `prefix` is the ancestor guide drawn before a node's own connector; roots
  // sit flush at the tree's column 0 (no connector), their subtrees draw glyphs.
  const walk = (node: DocumentSummary, prefix: string, isRoot: boolean, isLast: boolean) => {
    const branch = isRoot ? "" : isLast ? "└── " : "├── ";
    const title = node.title || "(untitled)";
    lines.push(`${node.id.padEnd(idWidth)}  ${prefix}${branch}${title}`);
    const kids = children.get(node.id) ?? [];
    const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
    kids.forEach((child, i) => walk(child, childPrefix, false, i === kids.length - 1));
  };
  roots.forEach((root) => walk(root, "", true, true));
  return lines.join("\n");
}

const create = defineCommand({
  meta: { name: "create", description: "Create a markdown document" },
  args: {
    title: { type: "string", required: true, description: "Document title" },
    body: { type: "string", description: "Markdown body (@file/@- ok)" },
    db: { type: "string", description: "Owning database ref (id/prefix/name)" },
    parent: { type: "string", description: "Parent document ref (id/prefix/title)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const body = await resolveValue(args.body);
    const row = createDocument(db, {
      title: args.title,
      body,
      database_id: args.db != null ? resolveRef(db, args.db, { kind: "db" }) : undefined,
      parent_id: args.parent != null ? docId(db, args.parent) : undefined,
    });
    print(
      { id: row.id, title: row.title, bytes: (row.body ?? "").length },
      () => `${row.id}\t${row.title}`,
    );
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List documents as a parent/child tree" },
  args: { db: { type: "string", description: "Filter by database ref (id/prefix/name)" } },
  run: guard((args) => {
    const db = openMetahub();
    const rows = listDocuments(db, {
      database_id: args.db != null ? resolveRef(db, args.db, { kind: "db" }) : undefined,
    });
    print(rows, () => docTree(rows));
  }),
});

const get = defineCommand({
  meta: { name: "get", description: "Show one document" },
  args: { id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" } },
  run: guard((args) => {
    const db = openMetahub();
    const row = getDocument(db, docId(db, args.id))!;
    print(row, () => row.body ?? "");
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a document's title/body/parent" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    title: { type: "string" },
    body: { type: "string", description: "Markdown body (@file/@- ok)" },
    parent: {
      type: "string",
      description: 'Reparent under this document ref; --parent "" moves to top level',
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const body = await resolveValue(args.body);
    // Untouched when omitted; "" clears the parent (top level); otherwise reparent.
    const parent_id =
      args.parent === undefined ? undefined : args.parent === "" ? null : docId(db, args.parent);
    const row = updateDocument(db, docId(db, args.id), { title: args.title, body, parent_id });
    print({ id: row.id, title: row.title, parent_id: row.parent_id, bytes: (row.body ?? "").length });
  }),
});

const read = defineCommand({
  meta: {
    name: "read",
    description: "Read a document with a version token (read before edit)",
  },
  args: { id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" } },
  run: guard((args) => {
    const db = openMetahub();
    const id = docId(db, args.id);
    const row = getDocument(db, id)!;
    const body = row.body ?? "";
    print(
      {
        id: row.id,
        title: row.title,
        version: documentVersion(db, id),
        lines: body ? body.split("\n").length : 0,
        bytes: body.length,
        body,
      },
      () => body,
    );
  }),
});

const edit = defineCommand({
  meta: {
    name: "edit",
    description:
      "Anchored find/replace; --old must match exactly once unless --replace-all",
  },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    old: { type: "string", required: true, description: "Exact text to find (@file/@- ok)" },
    new: { type: "string", description: "Replacement text (@file/@- ok)" },
    "replace-all": { type: "boolean", description: "Replace every occurrence" },
    "if-match": { type: "string", description: "Version from `doc read`; reject if changed" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const oldText = await resolveValue(args.old);
    const newText = (await resolveValue(args.new)) ?? "";
    const r = editDocument(db, docId(db, args.id), {
      old: oldText!,
      new: newText,
      replaceAll: args["replace-all"],
      ifMatch: args["if-match"],
    });
    print(r, () => `edited ${r.id} (${r.replaced} replaced)`);
  }),
});

const append = defineCommand({
  meta: { name: "append", description: "Append markdown as new block(s)" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    body: { type: "string", required: true, description: "Markdown (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const body = (await resolveValue(args.body)) ?? "";
    const r = appendDocument(db, docId(db, args.id), body);
    print(r, () => `appended ${r.replaced} block(s) to ${r.id}`);
  }),
});

const prepend = defineCommand({
  meta: { name: "prepend", description: "Prepend markdown as new block(s)" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    body: { type: "string", required: true, description: "Markdown (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const body = (await resolveValue(args.body)) ?? "";
    const r = prependDocument(db, docId(db, args.id), body);
    print(r, () => `prepended ${r.replaced} block(s) to ${r.id}`);
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a document" },
  args: { id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" } },
  run: guard((args) => {
    const db = openMetahub();
    const id = docId(db, args.id);
    deleteDocument(db, id);
    print({ ok: true, deleted: id });
  }),
});

export default defineCommand({
  meta: { name: "doc", description: "Manage markdown documents" },
  subCommands: { create, list, get, read, update, edit, append, prepend, delete: del },
});
