import { defineCommand } from "citty";
import type { Database } from "bun:sqlite";
import { openMetahub } from "../../core/db.ts";
import {
  createDocument,
  listDocuments,
  getDocument,
  updateDocument,
  editDocument,
  editDocumentBatch,
  appendDocument,
  prependDocument,
  duplicateDocument,
  deleteDocument,
  documentVersion,
  type DocumentSummary,
  type EditPair,
} from "../../core/documents.ts";
import {
  listDocumentRevisions,
  documentAtVersion,
  revertDocument,
  type DocRevision,
} from "../../core/history.ts";
import { resolveValue, resolveJson } from "../input.ts";
import { resolveRef } from "../../core/resolve.ts";
import { errorCode, MhError } from "../../core/errors.ts";
import { idKind } from "../../core/ids.ts";
import { print, table, guard } from "../output.ts";
import { FRESH_ARGS, freshDb } from "../fresh.ts";

/** Resolve a document ref (id/prefix/title) to its id. */
function docId(db: Database, ref: string): string {
  return resolveRef(db, ref, { kind: "doc" });
}

/** Like docId, but lets a full id of a tombstoned document pass through —
 *  history and revert must reach deleted documents (revert resurrects them). */
function docIdMaybeDeleted(db: Database, ref: string): string {
  try {
    return docId(db, ref);
  } catch (e) {
    if (errorCode(e) === "not_found" && idKind(ref) === "doc") return ref;
    throw e;
  }
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
  args: {
    db: { type: "string", description: "Filter by database ref (id/prefix/name)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = listDocuments(db, {
      database_id: args.db != null ? resolveRef(db, args.db, { kind: "db" }) : undefined,
    });
    print(rows, () => docTree(rows));
  }),
});

const get = defineCommand({
  meta: { name: "get", description: "Show one document" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    at: { type: "string", description: "Show the document as of this version token (from `doc history`)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    if (args.at !== undefined) {
      const past = documentAtVersion(db, docIdMaybeDeleted(db, args.id), args.at);
      print(past, () => past.body);
      return;
    }
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
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
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

/** Validate a decoded `--edits` payload into EditPair[] (shape only; the core
 *  handles anchor semantics). Throws invalid_input so guard maps it to exit 2. */
function parseEditPairs(raw: unknown): EditPair[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new MhError("invalid_input", "--edits must be a non-empty JSON array");
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null)
      throw new MhError("invalid_input", `--edits[${i}] must be an object`);
    const { old, new: repl, replaceAll } = e as Record<string, unknown>;
    if (typeof old !== "string" || old === "")
      throw new MhError("invalid_input", `--edits[${i}].old must be a non-empty string`);
    if (repl !== undefined && typeof repl !== "string")
      throw new MhError("invalid_input", `--edits[${i}].new must be a string`);
    if (replaceAll !== undefined && typeof replaceAll !== "boolean")
      throw new MhError("invalid_input", `--edits[${i}].replaceAll must be a boolean`);
    return { old, new: repl as string | undefined, replaceAll: replaceAll as boolean | undefined };
  });
}

const edit = defineCommand({
  meta: {
    name: "edit",
    description:
      "Anchored find/replace; --old must match exactly once unless --replace-all. --edits applies a JSON batch of pairs atomically",
  },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    old: { type: "string", description: "Exact text to find (@file/@- ok)" },
    new: { type: "string", description: "Replacement text (@file/@- ok)" },
    "replace-all": { type: "boolean", description: "Replace every occurrence" },
    edits: {
      type: "string",
      description: 'Batch JSON: [{"old","new"?,"replaceAll"?}], applied in order (@file/@- ok)',
    },
    "if-match": { type: "string", description: "Version from `doc read`; reject if changed" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const id = docId(db, args.id);

    // Batch: one atomic, single-versioned pass over N pairs. Mutually exclusive
    // with the single-pair flags so intent is never ambiguous.
    if (args.edits != null) {
      if (args.old != null || args.new != null || args["replace-all"])
        throw new MhError("invalid_input", "use --old/--new/--replace-all or --edits, not both");
      const edits = parseEditPairs(await resolveJson(args.edits));
      const r = editDocumentBatch(db, id, { edits, ifMatch: args["if-match"] });
      print(r, () => `edited ${r.id} (${r.replaced} replaced across ${edits.length} edit(s))`);
      return;
    }

    if (args.old == null) throw new MhError("invalid_input", "need --old or --edits");
    const oldText = await resolveValue(args.old);
    const newText = (await resolveValue(args.new)) ?? "";
    const r = editDocument(db, id, {
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

/** One-line summary of what a revision touched, for the history table. */
function docRevisionSummary(r: DocRevision): string {
  const parts: string[] = [];
  if (r.kind !== "user") parts.push(`[${r.kind}]`);
  if (r.created) parts.push("created");
  if (r.deleted) parts.push("deleted");
  if (r.title_changed) parts.push("title");
  if (r.blocks_changed) parts.push(`~${r.blocks_changed} block(s)`);
  if (r.blocks_deleted) parts.push(`-${r.blocks_deleted} block(s)`);
  return parts.join(", ") || "metadata";
}

const history = defineCommand({
  meta: { name: "history", description: "List a document's revisions (newest first)" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    ...FRESH_ARGS,
  },
  run: guard(async (args) => {
    const db = await freshDb(args);
    const rows = listDocumentRevisions(db, docIdMaybeDeleted(db, args.id));
    print(rows, () =>
      table(
        rows.map((r) => ({
          version: r.version,
          at: r.at,
          node: r.node_id,
          summary: docRevisionSummary(r),
        })),
      ),
    );
  }),
});

const revert = defineCommand({
  meta: {
    name: "revert",
    description: "Restore title/body to a past version (recorded as a new revision)",
  },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    to: { type: "string", required: true, description: "Version token from `doc history`" },
    "if-match": { type: "string", description: "Version from `doc read`; reject if changed" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const r = revertDocument(db, docIdMaybeDeleted(db, args.id), args.to, {
      ifMatch: args["if-match"],
    });
    print(r, () =>
      r.changed
        ? `reverted ${r.id} to ${r.restored}` + (r.undeleted ? " [undeleted]" : "")
        : `no change: ${r.id} already matches ${r.restored}`,
    );
  }),
});

const duplicate = defineCommand({
  meta: { name: "duplicate", description: "Copy a document (title + all blocks) next to the source" },
  args: {
    id: { type: "positional", required: true, description: "Document ref (id/prefix/title)" },
    title: { type: "string", description: "Title for the copy (defaults to the source title)" },
  },
  run: guard((args) => {
    const db = openMetahub();
    const row = duplicateDocument(db, docId(db, args.id), { title: args.title });
    print({ id: row.id, title: row.title }, () => `${row.id}\t${row.title}`);
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
  subCommands: { create, list, get, read, update, edit, append, prepend, history, revert, duplicate, delete: del },
});
