import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import {
  createDocument,
  listDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
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
  subCommands: { create, list, get, update, delete: del },
});
