// HTTP → worker-op mapping for the service worker's offline gateway: when a
// /api/* request can't reach the server, the SW translates it to the same
// worker RPC the WebUI's local-api facade uses and executes it against the
// local replica via a page client. One table, mirroring the route semantics in
// src/webui/server/routes.ts — keep the three in sync (routes, local-api, here).
//
// Dependency-free on purpose: this module is bundled into sw.ts, which must
// stay a plain classic script.

export interface MappedCall {
  op: string;
  args: unknown[];
}

type Body = Record<string, unknown> | null;

/** Map a same-origin /api/* request to a replica op, or null when the endpoint
 *  has no local counterpart (admin/server-only: peers, grants, sites upload,
 *  version, pairing). */
export function mapApiRequest(
  method: string,
  pathname: string,
  q: URLSearchParams,
  body: Body,
): MappedCall | null {
  const id = q.get("id");
  const db = q.get("db");
  const b = body ?? {};
  const num = (s: string | null) => (s != null ? Number(s) : undefined);
  const key = `${method} ${pathname}`;

  switch (key) {
    // databases
    case "GET /api/databases":
      return { op: "listDatabases", args: [] };
    case "POST /api/databases":
      return { op: "createDatabase", args: [b] };
    case "PATCH /api/database":
      return id ? { op: "updateDatabase", args: [id, b] } : null;
    case "POST /api/database/duplicate":
      return id ? { op: "duplicateDatabase", args: [id, b] } : null;
    case "DELETE /api/database":
      return id ? { op: "deleteDatabase", args: [id] } : null;
    case "GET /api/database/activity":
      return db ? { op: "listDatabaseActivity", args: [db, num(q.get("limit"))] } : null;

    // properties
    case "GET /api/properties":
      return db ? { op: "listProperties", args: [db] } : null;
    case "POST /api/properties": {
      const { db: bodyDb, ...rest } = b as { db?: string };
      return bodyDb ? { op: "addProperty", args: [bodyDb, rest] } : null;
    }
    case "PATCH /api/property":
      return id ? { op: "updateProperty", args: [id, b] } : null;
    case "PATCH /api/property/width":
      return id ? { op: "setPropertyWidth", args: [id, (b as { width?: number }).width] } : null;
    case "DELETE /api/property":
      return id ? { op: "removeProperty", args: [id] } : null;
    case "GET /api/property/history":
      return id ? { op: "listPropertyRevisions", args: [id] } : null;
    case "POST /api/property/revert":
      return id ? { op: "revertProperty", args: [id, (b as { to?: string }).to] } : null;

    // records
    case "GET /api/records":
      return db
        ? { op: "listRecords", args: [db, { sort: q.get("sort") ?? undefined, limit: num(q.get("limit")) }] }
        : null;
    case "POST /api/records":
      return db ? { op: "createRecord", args: [db, b] } : null;
    case "GET /api/record":
      return id ? { op: "getRecord", args: [id] } : null;
    case "PATCH /api/record":
      return id ? { op: "updateRecord", args: [id, b] } : null;
    case "PATCH /api/record/order": {
      const { target, where } = b as { target?: string; where?: string };
      return id && target ? { op: "moveRecord", args: [id, target, where] } : null;
    }
    case "GET /api/record/history":
      return id ? { op: "listRecordRevisions", args: [id] } : null;
    case "GET /api/record/at":
      return id ? { op: "recordAtVersion", args: [id, q.get("version")] } : null;
    case "GET /api/record/field-history":
      return id ? { op: "recordFieldHistory", args: [id, q.get("prop")] } : null;
    case "POST /api/record/revert":
      return id ? { op: "revertRecord", args: [id, (b as { to?: string }).to] } : null;
    case "DELETE /api/record":
      return id ? { op: "deleteRecord", args: [id] } : null;

    // documents
    case "GET /api/documents":
      return {
        op: "listDocuments",
        args: [
          {
            database_id: q.get("db") ?? undefined,
            parent_id: q.get("parent") ?? undefined,
          },
        ],
      };
    case "POST /api/documents":
      return { op: "createDocument", args: [b] };
    case "GET /api/document":
      return id ? { op: "getDocument", args: [id] } : null;
    case "PATCH /api/document": {
      const { if_match, ...fields } = b as { if_match?: string };
      return id ? { op: "updateDocument", args: [id, fields, if_match] } : null;
    }
    case "POST /api/document/duplicate":
      return id ? { op: "duplicateDocument", args: [id, b] } : null;
    case "PATCH /api/document/move": {
      const { target, where } = b as { target?: string; where?: string };
      return id && target ? { op: "moveDocument", args: [id, target, where] } : null;
    }
    case "GET /api/document/history":
      return id ? { op: "listDocumentRevisions", args: [id] } : null;
    case "GET /api/document/at":
      return id ? { op: "documentAtVersion", args: [id, q.get("version")] } : null;
    case "POST /api/document/revert": {
      const { to, if_match } = b as { to?: string; if_match?: string };
      return id && to ? { op: "revertDocument", args: [id, to, if_match] } : null;
    }
    case "DELETE /api/document":
      return id ? { op: "deleteDocument", args: [id] } : null;

    // nodes + search
    case "GET /api/nodes":
      return { op: "nodes", args: [] };
    case "GET /api/sync/health":
      return { op: "dataMap", args: [] };
    case "GET /api/search": {
      const text = q.get("q");
      return text ? { op: "search", args: [text, num(q.get("limit"))] } : null;
    }

    default:
      return null;
  }
}
