import { z } from "zod";
import { MhError } from "../../core/errors.ts";
import { errorResponse, type Route, type RouteCtx } from "../../core/sync/routes.ts";
import {
  listDatabases,
  createDatabase,
  updateDatabase,
  duplicateDatabase,
  deleteDatabase,
} from "../../core/databases.ts";
import {
  listProperties,
  addProperty,
  updateProperty,
  setPropertyWidth,
  removeProperty,
  type PropType,
  type PropertyConfig,
} from "../../core/properties.ts";
import {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  moveRecord,
  deleteRecord,
} from "../../core/records.ts";
import {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  documentVersion,
  moveDocument,
  duplicateDocument,
  deleteDocument,
} from "../../core/documents.ts";
import {
  listDocumentRevisions,
  documentAtVersion,
  revertDocument,
  listRecordRevisions,
  recordAtVersion,
  recordFieldHistory,
  revertRecord,
  listPropertyRevisions,
  revertProperty,
  listDatabaseActivity,
} from "../../core/history.ts";
import { search } from "../../core/search.ts";
import { getNodeId } from "../../core/node.ts";
import {
  cacheStats,
  readPolicy,
  knownNodes,
  clearCache,
  reconcileCache,
  setFullNodes,
  setRedundancy,
  announceLocalCache,
} from "../../core/blobs.ts";
import pkg from "../../../package.json" with { type: "json" };

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
  values: z
    .record(z.string(), z.any())
    .describe(
      'Field values keyed by property name (e.g. {"Amount":35}). Reads nest cells here; writes take a flat {column: value} map. Lossy when two properties share a name — prefer `cells` then.',
    ),
  cells: z
    .record(z.string(), z.any())
    .describe(
      "Field values keyed by property id — lossless under duplicate property names. Writes accept property ids as keys too.",
    ),
});
const MoveRecordReq = z.object({
  target: z.string(),
  where: z.enum(["before", "after"]),
});
const DocumentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  database_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  created_hlc: z.string(),
  order_key: z.string().nullable(),
});
const MoveDocumentReq = z.object({
  target: z.string(),
  where: z.enum(["before", "after", "into"]),
});
const DocumentSchema = DocumentSummarySchema.extend({
  body: z.string().nullable(),
  // Read/edit token (max HLC over the doc + its blocks); echo it back as
  // `if_match` on PATCH to detect concurrent changes.
  version: z.string().optional(),
});
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
const DuplicateDatabaseReq = z.object({
  name: z.string().optional().describe("Name for the copy (defaults to the source name)"),
  icon: z.string().optional(),
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
const SetWidthReq = z.object({ width: z.number() });
const RecordValuesReq = z
  .record(z.string(), z.any())
  .describe('Flat { column: value } cell patch (keyed by property name).');
const CreateDocumentReq = z.object({
  title: z.string(),
  body: z.string().optional(),
  database_id: z.string().optional(),
  parent_id: z.string().optional(),
});
const UpdateDocumentReq = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  // Optimistic concurrency: a `version` from GET /api/document. A concurrent
  // change (CLI, another window, sync) makes the PATCH fail 409 `stale`
  // instead of silently clobbering it.
  if_match: z.string().optional(),
});
const DuplicateDocumentReq = z.object({
  title: z.string().optional().describe("Title for the copy (defaults to the source title)"),
  parent_id: z.string().nullable().optional(),
});

const RevisionBase = z.object({
  // Version token (max HLC of the revision); pass as `to` on revert or
  // `version` on GET /api/document/at.
  version: z.string(),
  at: z.string().describe("Wall-clock time of the revision (ISO 8601)"),
  node_id: z.string(),
  kind: z.enum(["user", "repair", "revert"]).describe("Source of the revision"),
  changes: z.number(),
  created: z.boolean(),
  deleted: z.boolean(),
});
const DocRevisionSchema = RevisionBase.extend({
  title_changed: z.boolean(),
  blocks_changed: z.number(),
  blocks_deleted: z.number(),
});
const RecordRevisionSchema = RevisionBase.extend({
  fields: z.array(z.string()).describe("Property ids of the cells written"),
  moved: z.boolean(),
});
const DatabaseActivityEntrySchema = RecordRevisionSchema.extend({
  record_id: z.string(),
  record_title: z
    .string()
    .nullable()
    .describe("Title-property value as of this revision (deleted records keep their last title)"),
  diffs: z
    .array(
      z.object({
        prop: z.string(),
        before: z.any().optional(),
        after: z.any().optional(),
      }),
    )
    .describe("Value-level cell changes; a missing side means the cell did not exist"),
});
const DocumentVersionStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  deleted: z.boolean(),
  version: z.string(),
});
const RevertDocumentReq = z.object({
  to: z.string().describe("Version token from /api/document/history"),
  if_match: z.string().optional(),
});
const RevertRecordReq = z.object({
  to: z.string().describe("Version token from /api/record/history"),
});
const RevertDocResultSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  restored: z.string(),
  version: z.string(),
  undeleted: z.boolean(),
});
const RevertRecordResultSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  fields: z.array(z.string()),
  undeleted: z.boolean(),
  restored: z.string(),
});
const PropertyRevisionSchema = RevisionBase.extend({
  fields: z.array(z.string()).describe("Definition columns touched (name/type/config/position)"),
  cells_cleared: z.number(),
});
const RevertPropertyReq = z.object({
  to: z.string().describe("Version token from /api/property/history"),
});
const RevertPropertyResultSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  fields: z.array(z.string()),
  restored_cells: z.number(),
  skipped_cells: z.number(),
  undeleted: z.boolean(),
  restored: z.string(),
});
const RecordVersionStateSchema = z.object({
  id: z.string(),
  database_id: z.string().nullable(),
  deleted: z.boolean(),
  data: z.record(z.string(), z.any()).describe("Cells at that version, keyed by property id"),
  version: z.string(),
});
const FieldHistoryEntrySchema = z.object({
  version: z.string(),
  at: z.string(),
  node_id: z.string(),
  value: z.any().optional(),
  cleared: z.boolean(),
});
const NodeInfoSchema = z.object({
  node_id: z.string(),
  label: z.string().nullable().describe("Peer label from pairing; null when unnamed"),
  self: z.boolean().describe("True for the node serving this request"),
});
const CacheStatsSchema = z.object({
  totalBytes: z.number(),
  clearableBytes: z.number(),
  retainedBytes: z.number(),
  count: z.number(),
  clearableCount: z.number(),
});
const BlobPolicySchema = z.object({
  fullNodes: z.array(z.string()),
  redundancy: z.enum(["all", "any"]),
});
const KnownNodeSchema = z.object({
  nodeId: z.string(),
  label: z.string().nullable(),
  self: z.boolean(),
});
const BlobCacheSchema = z.object({
  stats: CacheStatsSchema,
  policy: BlobPolicySchema,
  nodes: z.array(KnownNodeSchema),
});
const ClearResultSchema = z.object({
  cleared: z.number(),
  freedBytes: z.number(),
  skipped: z.number(),
});
const SetBlobPolicyReq = z.object({
  full_nodes: z.array(z.string()).optional().describe("Node ids designated as full blob libraries"),
  redundancy: z.enum(["all", "any"]).optional(),
});
const SetBlobPolicyResSchema = z.object({
  policy: BlobPolicySchema,
  announced: z.number().describe("Blobs this device announced as held (if it just became a library)"),
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
      return errorResponse(e);
    }
  };
}

// --- routes -----------------------------------------------------------------

const VersionSchema = z.object({ version: z.string() });

export const webuiRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/version",
    summary: "Version of the running core (sidecar). Used by the desktop app's settings footer.",
    response: VersionSchema,
    handler: () => Response.json({ version: pkg.version }),
  },
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
    method: "POST",
    path: "/api/database/duplicate",
    summary: "Copy a database whole — schema and all records. Query: ?id=<id>",
    request: DuplicateDatabaseReq,
    response: DatabaseSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json().catch(() => ({}))) as { name?: string; icon?: string };
      return duplicateDatabase(db, need(req, "id"), body);
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
    path: "/api/database/activity",
    summary:
      "Recent changes across all records of a database, newest first. Query: ?db=<id>&limit=<n>",
    response: z.array(DatabaseActivityEntrySchema),
    handler: handle((req, { db }) => {
      const limit = opt(req, "limit");
      return listDatabaseActivity(db, need(req, "db"), {
        limit: limit ? Number(limit) : undefined,
      });
    }),
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
    method: "PATCH",
    path: "/api/property/width",
    summary: "Set a property's table column width (px). Query: ?id=<id>",
    request: SetWidthReq,
    response: PropertySchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { width: number };
      return setPropertyWidth(db, need(req, "id"), body.width);
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
    path: "/api/property/history",
    summary: "List a property's definition revisions, newest first. Query: ?id=<id>",
    response: z.array(PropertyRevisionSchema),
    handler: handle((req, { db }) => listPropertyRevisions(db, need(req, "id"))),
  },
  {
    method: "POST",
    path: "/api/property/revert",
    summary:
      "Schema rollback: restore a property's definition and the cells its type-change/removal cleared (user edits since are kept). Query: ?id=<id>",
    request: RevertPropertyReq,
    response: RevertPropertyResultSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { to: string };
      return revertProperty(db, need(req, "id"), body.to);
    }),
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
      const id = need(req, "id");
      const rec = getRecord(db, id);
      if (!rec) throw new MhError("not_found", `no such record: ${id}`);
      return rec;
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
    method: "PATCH",
    path: "/api/record/order",
    summary: "Move a record before or after another record. Query: ?id=<id>",
    request: MoveRecordReq,
    response: RecordSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { target: string; where: "before" | "after" };
      return moveRecord(db, need(req, "id"), body.target, body.where);
    }),
  },
  {
    method: "GET",
    path: "/api/record/history",
    summary: "List a record's revisions, newest first. Query: ?id=<id>",
    response: z.array(RecordRevisionSchema),
    handler: handle((req, { db }) => listRecordRevisions(db, need(req, "id"))),
  },
  {
    method: "GET",
    path: "/api/record/at",
    summary: "A record's cells as of a past version. Query: ?id=<id>&version=<token>",
    response: RecordVersionStateSchema,
    handler: handle((req, { db }) => recordAtVersion(db, need(req, "id"), need(req, "version"))),
  },
  {
    method: "GET",
    path: "/api/record/field-history",
    summary: "The write trail of one record cell, newest first. Query: ?id=<id>&prop=<propertyId>",
    response: z.array(FieldHistoryEntrySchema),
    handler: handle((req, { db }) => recordFieldHistory(db, need(req, "id"), need(req, "prop"))),
  },
  {
    method: "POST",
    path: "/api/record/revert",
    summary:
      "Restore a record's cells to a past version, recorded as a new revision. Query: ?id=<id>",
    request: RevertRecordReq,
    response: RevertRecordResultSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { to: string };
      return revertRecord(db, need(req, "id"), body.to);
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
    summary: "List documents. Optional query: ?db=<id> or ?parent=<id>",
    response: z.array(DocumentSummarySchema),
    handler: handle((req, { db }) =>
      listDocuments(db, { database_id: opt(req, "db"), parent_id: opt(req, "parent") }),
    ),
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
        parent_id?: string;
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
      const id = need(req, "id");
      const doc = getDocument(db, id);
      if (!doc) throw new MhError("not_found", `no such document: ${id}`);
      return { ...doc, version: documentVersion(db, doc.id) };
    }),
  },
  {
    method: "PATCH",
    path: "/api/document",
    summary: "Update a document's title/body/parent_id (null = top level). Query: ?id=<id>",
    request: UpdateDocumentReq,
    response: DocumentSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as {
        title?: string;
        body?: string;
        parent_id?: string | null;
        if_match?: string;
      };
      const { if_match, ...fields } = body;
      const doc = updateDocument(db, need(req, "id"), fields, { ifMatch: if_match });
      return { ...doc, version: documentVersion(db, doc.id) };
    }),
  },
  {
    method: "POST",
    path: "/api/document/duplicate",
    summary: "Copy a document — title and every block — next to the source. Query: ?id=<id>",
    request: DuplicateDocumentReq,
    response: DocumentSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json().catch(() => ({}))) as {
        title?: string;
        parent_id?: string | null;
      };
      const doc = duplicateDocument(db, need(req, "id"), {
        title: body.title,
        parentId: body.parent_id,
      });
      return { ...doc, version: documentVersion(db, doc.id) };
    }),
  },
  {
    method: "PATCH",
    path: "/api/document/move",
    summary: "Move a document before/after another, or into it as a child. Query: ?id=<id>",
    request: MoveDocumentReq,
    response: DocumentSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { target: string; where: "before" | "after" | "into" };
      return moveDocument(db, need(req, "id"), body.target, body.where);
    }),
  },
  {
    method: "GET",
    path: "/api/document/history",
    summary: "List a document's revisions, newest first. Query: ?id=<id>",
    response: z.array(DocRevisionSchema),
    handler: handle((req, { db }) => listDocumentRevisions(db, need(req, "id"))),
  },
  {
    method: "GET",
    path: "/api/document/at",
    summary: "A document's title/body as of a past version. Query: ?id=<id>&version=<token>",
    response: DocumentVersionStateSchema,
    handler: handle((req, { db }) => documentAtVersion(db, need(req, "id"), need(req, "version"))),
  },
  {
    method: "POST",
    path: "/api/document/revert",
    summary:
      "Restore a document's title/body to a past version, recorded as a new revision. Query: ?id=<id>",
    request: RevertDocumentReq,
    response: RevertDocResultSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { to: string; if_match?: string };
      return revertDocument(db, need(req, "id"), body.to, { ifMatch: body.if_match });
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
    path: "/api/nodes",
    summary: "Known nodes for display: this device plus paired peers with their labels",
    response: z.array(NodeInfoSchema),
    handler: handle((_req, { db }) => {
      const self = getNodeId(db);
      const peers = db
        .query(
          "SELECT node_id, label FROM peers WHERE node_id IS NOT NULL AND node_id <> '' GROUP BY node_id",
        )
        .all() as { node_id: string; label: string | null }[];
      return [
        { node_id: self, label: null, self: true },
        ...peers.filter((p) => p.node_id !== self).map((p) => ({ ...p, self: false })),
      ];
    }),
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
  {
    method: "GET",
    path: "/api/blob-cache",
    summary:
      "Local blob cache stats + clear policy + device roster (Settings storage panel). " +
      "Only blobs durably held by a designated full blob device are clearable.",
    response: BlobCacheSchema,
    handler: handle((_req, { db }) => {
      reconcileCache(db);
      return { stats: cacheStats(db), policy: readPolicy(db), nodes: knownNodes(db) };
    }),
  },
  {
    method: "POST",
    path: "/api/blob-cache/clear",
    summary:
      "Drop locally-cached blob bytes a full blob device durably holds (the reference stays; bytes re-download on demand). Returns bytes freed.",
    response: ClearResultSchema,
    handler: handle((_req, { db }) => clearCache(db)),
  },
  {
    method: "POST",
    path: "/api/blob-policy",
    summary:
      "Set the full blob device(s) and/or redundancy (all|any). When this device becomes a library it announces the blobs it already holds.",
    request: SetBlobPolicyReq,
    response: SetBlobPolicyResSchema,
    handler: handle(async (req, { db }) => {
      const body = (await req.json()) as { full_nodes?: string[]; redundancy?: "all" | "any" };
      if (body.full_nodes) setFullNodes(db, body.full_nodes);
      if (body.redundancy) setRedundancy(db, body.redundancy);
      const announced = announceLocalCache(db); // no-op unless this node is now full
      return { policy: readPolicy(db), announced };
    }),
  },
];
