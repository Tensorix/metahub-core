import { defineCommand } from "citty";
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
} from "../../core/documents.ts";
import { resolveValue } from "../input.ts";
import { print, fail, table, guard } from "../output.ts";

const create = defineCommand({
  meta: { name: "create", description: "Create a markdown document" },
  args: {
    title: { type: "string", required: true, description: "Document title" },
    body: { type: "string", description: "Markdown body (@file/@- ok)" },
    db: { type: "string", description: "Owning database id" },
    parent: { type: "string", description: "Parent document id" },
  },
  run: guard(async (args) => {
    const body = await resolveValue(args.body);
    const row = createDocument(openMetahub(), {
      title: args.title,
      body,
      database_id: args.db,
      parent_id: args.parent,
    });
    print(
      { id: row.id, title: row.title, bytes: (row.body ?? "").length },
      () => `${row.id}\t${row.title}`,
    );
  }),
});

const list = defineCommand({
  meta: { name: "list", description: "List documents" },
  args: { db: { type: "string", description: "Filter by database id" } },
  run: guard((args) => {
    const rows = listDocuments(openMetahub(), { database_id: args.db });
    print(rows, () => table(rows.map((r) => ({ id: r.id, title: r.title }))));
  }),
});

const get = defineCommand({
  meta: { name: "get", description: "Show one document" },
  args: { id: { type: "positional", required: true, description: "Document id" } },
  run: guard((args) => {
    const row = getDocument(openMetahub(), args.id);
    if (!row) fail(`no such document: ${args.id}`);
    print(row, () => row!.body ?? "");
  }),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a document" },
  args: {
    id: { type: "positional", required: true, description: "Document id" },
    title: { type: "string" },
    body: { type: "string", description: "Markdown body (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const body = await resolveValue(args.body);
    const row = updateDocument(openMetahub(), args.id, { title: args.title, body });
    print({ id: row.id, title: row.title, bytes: (row.body ?? "").length });
  }),
});

const read = defineCommand({
  meta: {
    name: "read",
    description: "Read a document with a version token (read before edit)",
  },
  args: { id: { type: "positional", required: true, description: "Document id" } },
  run: guard((args) => {
    const db = openMetahub();
    const row = getDocument(db, args.id);
    if (!row) fail(`no such document: ${args.id}`);
    const body = row!.body ?? "";
    print(
      {
        id: row!.id,
        title: row!.title,
        version: documentVersion(db, args.id),
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
    id: { type: "positional", required: true, description: "Document id" },
    old: { type: "string", required: true, description: "Exact text to find (@file/@- ok)" },
    new: { type: "string", description: "Replacement text (@file/@- ok)" },
    "replace-all": { type: "boolean", description: "Replace every occurrence" },
    "if-match": { type: "string", description: "Version from `doc read`; reject if changed" },
  },
  run: guard(async (args) => {
    const oldText = await resolveValue(args.old);
    const newText = (await resolveValue(args.new)) ?? "";
    const r = editDocument(openMetahub(), args.id, {
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
    id: { type: "positional", required: true, description: "Document id" },
    body: { type: "string", required: true, description: "Markdown (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const body = (await resolveValue(args.body)) ?? "";
    const r = appendDocument(openMetahub(), args.id, body);
    print(r, () => `appended ${r.replaced} block(s) to ${r.id}`);
  }),
});

const prepend = defineCommand({
  meta: { name: "prepend", description: "Prepend markdown as new block(s)" },
  args: {
    id: { type: "positional", required: true, description: "Document id" },
    body: { type: "string", required: true, description: "Markdown (@file/@- ok)" },
  },
  run: guard(async (args) => {
    const body = (await resolveValue(args.body)) ?? "";
    const r = prependDocument(openMetahub(), args.id, body);
    print(r, () => `prepended ${r.replaced} block(s) to ${r.id}`);
  }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a document" },
  args: { id: { type: "positional", required: true, description: "Document id" } },
  run: guard((args) => {
    if (!deleteDocument(openMetahub(), args.id)) fail(`no such document: ${args.id}`);
    print({ ok: true, deleted: args.id });
  }),
});

export default defineCommand({
  meta: { name: "doc", description: "Manage markdown documents" },
  subCommands: { create, list, get, read, update, edit, append, prepend, delete: del },
});
