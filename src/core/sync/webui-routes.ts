import { z } from "zod";
import type { Route, RouteCtx } from "./routes.ts";
import { listDatabases, createDatabase, updateDatabase, deleteDatabase } from "../databases.ts";
import {
  listProperties,
  addProperty,
  updateProperty,
  removeProperty,
  type PropType,
  type PropertyConfig,
} from "../properties.ts";
import {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
} from "../records.ts";
import {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,
} from "../documents.ts";
import { search } from "../search.ts";

// Read-only viewer + light editing for the browser UI. These routes wrap the
// same core functions the CLI uses, so every write goes through `emit()` and
// replicates over /sync. Ids are carried as query params to keep the server's
// exact-path matcher (see ./routes.ts) and OpenAPI generation unchanged.

// --- pragmatic schemas (drive /docs; intentionally loose) -------------------

const DatabaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  created_hlc: z.string(),
});
const PropertySchema = z.object({
  id: z.string(),
  database_id: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.any().nullable(),
  position: z.number(),
});
const RecordSchema = z.object({
  id: z.string(),
  database_id: z.string(),
  values: z.record(z.string(), z.any()),
});
const DocumentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  database_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  created_hlc: z.string(),
});
const DocumentSchema = DocumentSummarySchema.extend({ body: z.string().nullable() });
const SearchHitSchema = z.object({
  type: z.string(),
  id: z.string(),
  database_id: z.string().nullable(),
  title: z.string().optional(),
  snippet: z.string(),
});
const OkSchema = z.object({ ok: z.boolean() });

const CreateDatabaseReq = z.object({ name: z.string(), icon: z.string().optional() });
const UpdateDatabaseReq = z.object({
  name: z.string().optional(),
  icon: z.string().nullable().optional(),
});
const CreatePropertyReq = z.object({
  db: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.any().optional(),
});
const UpdatePropertyReq = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  config: z.any().optional(),
  position: z.number().optional(),
});
const RecordValuesReq = z.record(z.string(), z.any());
const CreateDocumentReq = z.object({
  title: z.string(),
  body: z.string().optional(),
  database_id: z.string().optional(),
});
const UpdateDocumentReq = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  parent_id: z.string().nullable().optional(),
});

// --- helpers ----------------------------------------------------------------

function need(req: Request, key: string): string {
  const v = new URL(req.url).searchParams.get(key);
  if (!v) throw new Error(`missing query param: ${key}`);
  return v;
}

function opt(req: Request, key: string): string | undefined {
  return new URL(req.url).searchParams.get(key) ?? undefined;
}

/** Wrap a handler: serialize the return value, turn thrown errors into 400 JSON. */
function handle(
  fn: (req: Request, ctx: RouteCtx) => unknown | Promise<unknown>,
): Route["handler"] {
  return async (req, ctx) => {
    try {
      const out = await fn(req, ctx);
      if (out instanceof Response) return out;
      return Response.json(out ?? null);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  };
}

// --- routes -----------------------------------------------------------------

export const webuiRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/databases",
    summary: "List all databases",
    response: z.array(DatabaseSchema),
    handler: handle((_req, { db }) => listDatabases(db)),
  },
  {
    method: "POST",
    path: "/api/databases",
    summary: "Create a database",
    request: CreateDatabaseReq,
    response: DatabaseSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { name: string; icon?: string };
      return createDatabase(db, body);
    }),
  },
  {
    method: "PATCH",
    path: "/api/database",
    summary: "Rename a database or change its icon. Query: ?id=<id>",
    request: UpdateDatabaseReq,
    response: DatabaseSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { name?: string; icon?: string | null };
      return updateDatabase(db, need(req, "id"), body);
    }),
  },
  {
    method: "DELETE",
    path: "/api/database",
    summary: "Delete a database (and stop it being the current one). Query: ?id=<id>",
    response: OkSchema,
    handler: handle((req, { db }) => ({ ok: deleteDatabase(db, need(req, "id")) })),
  },
  {
    method: "GET",
    path: "/api/properties",
    summary: "List a database's properties (columns). Query: ?db=<id>",
    response: z.array(PropertySchema),
    handler: handle((req, { db }) => listProperties(db, need(req, "db"))),
  },
  {
    method: "POST",
    path: "/api/properties",
    summary: "Add a property to a database",
    request: CreatePropertyReq,
    response: PropertySchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as {
        db: string;
        name: string;
        type: PropType;
        config?: PropertyConfig;
      };
      return addProperty(db, body.db, { name: body.name, type: body.type, config: body.config });
    }),
  },
  {
    method: "PATCH",
    path: "/api/property",
    summary: "Update a property: rename, change type, edit config/options, reorder. Query: ?id=<id>",
    request: UpdatePropertyReq,
    response: PropertySchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as {
        name?: string;
        type?: PropType;
        config?: PropertyConfig;
        position?: number;
      };
      return updateProperty(db, need(req, "id"), body);
    }),
  },
  {
    method: "DELETE",
    path: "/api/property",
    summary: "Delete a property (column) and its cells. Query: ?id=<id>",
    response: OkSchema,
    handler: handle((req, { db }) => ({ ok: removeProperty(db, need(req, "id")) })),
  },
  {
    method: "GET",
    path: "/api/records",
    summary: "List records in a database. Query: ?db=<id>&sort=<field>&limit=<n>",
    response: z.array(RecordSchema),
    handler: handle((req, { db }) => {
      const limit = opt(req, "limit");
      return listRecords(db, need(req, "db"), {
        sort: opt(req, "sort"),
        limit: limit ? Number(limit) : undefined,
      });
    }),
  },
  {
    method: "POST",
    path: "/api/records",
    summary: "Create a record. Query: ?db=<id>; body is a {field: value} map",
    request: RecordValuesReq,
    response: RecordSchema,
    handler: handle(async (req, { db }) => {
      const values = (await req.json()) as Record<string, unknown>;
      return createRecord(db, need(req, "db"), values);
    }),
  },
  {
    method: "GET",
    path: "/api/record",
    summary: "Get one record. Query: ?id=<id>",
    response: RecordSchema,
    handler: handle((req, { db }) => {
      const rec = getRecord(db, need(req, "id"));
      return rec ?? new Response("not found", { status: 404 });
    }),
  },
  {
    method: "PATCH",
    path: "/api/record",
    summary: "Update record fields. Query: ?id=<id>; body is a {field: value} map",
    request: RecordValuesReq,
    response: RecordSchema,
    handler: handle(async (req, { db }) => {
      const values = (await req.json()) as Record<string, unknown>;
      return updateRecord(db, need(req, "id"), values);
    }),
  },
  {
    method: "DELETE",
    path: "/api/record",
    summary: "Delete a record. Query: ?id=<id>",
    response: OkSchema,
    handler: handle((req, { db }) => ({ ok: deleteRecord(db, need(req, "id")) })),
  },
  {
    method: "GET",
    path: "/api/documents",
    summary: "List documents. Optional query: ?db=<id>",
    response: z.array(DocumentSummarySchema),
    handler: handle((req, { db }) => listDocuments(db, { database_id: opt(req, "db") })),
  },
  {
    method: "POST",
    path: "/api/documents",
    summary: "Create a document",
    request: CreateDocumentReq,
    response: DocumentSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as {
        title: string;
        body?: string;
        database_id?: string;
      };
      return createDocument(db, body);
    }),
  },
  {
    method: "GET",
    path: "/api/document",
    summary: "Get one document with full body. Query: ?id=<id>",
    response: DocumentSchema,
    handler: handle((req, { db }) => {
      const doc = getDocument(db, need(req, "id"));
      return doc ?? new Response("not found", { status: 404 });
    }),
  },
  {
    method: "PATCH",
    path: "/api/document",
    summary: "Update a document's title/body/parent_id (null = top level). Query: ?id=<id>",
    request: UpdateDocumentReq,
    response: DocumentSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { title?: string; body?: string; parent_id?: string | null };
      return updateDocument(db, need(req, "id"), body);
    }),
  },
  {
    method: "DELETE",
    path: "/api/document",
    summary: "Delete a document. Query: ?id=<id>",
    response: OkSchema,
    handler: handle((req, { db }) => ({ ok: deleteDocument(db, need(req, "id")) })),
  },
  {
    method: "GET",
    path: "/api/search",
    summary: "Full-text search across documents and records. Query: ?q=<text>&limit=<n>",
    response: z.array(SearchHitSchema),
    handler: handle((req, { db }) => {
      const limit = opt(req, "limit");
      return search(db, need(req, "q"), { limit: limit ? Number(limit) : undefined });
    }),
  },
];
