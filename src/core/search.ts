import type { Database } from "bun:sqlite";
import { ftsAvailable } from "./db.ts";

export interface SearchHit {
  type: "document" | "record";
  id: string;
  database_id: string | null;
  title?: string;
  snippet: string;
}

const TEXT_TYPES = "('text','url','select','multi_select','date')";

// Rebuild the FTS index only when the oplog has advanced since the last build.
function ensureIndex(db: Database): boolean {
  if (!ftsAvailable(db)) return false;
  const max =
    (db.query("SELECT MAX(hlc) AS h FROM crdt_changes").get() as { h: string | null }).h ?? "";
  const indexed =
    (db.query("SELECT value FROM meta WHERE key = 'search_hlc'").get() as { value: string } | null)
      ?.value ?? "";
  if (max === indexed) return true;

  db.query("DELETE FROM search_fts").run();
  for (const d of db
    .query("SELECT id, title, body, database_id FROM documents WHERE __deleted = 0")
    .all() as { id: string; title: string | null; body: string | null; database_id: string | null }[]) {
    db.query(
      "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('document', ?, ?, ?, ?)",
    ).run(d.id, d.database_id, d.title ?? "", d.body ?? "");
  }
  for (const r of db
    .query(
      `SELECT r.id AS id, r.database_id AS database_id, group_concat(je.value, ' ') AS body
       FROM records r, json_each(r.data) je
       JOIN properties p ON p.id = je.key AND p.__deleted = 0
       WHERE r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
       GROUP BY r.id`,
    )
    .all() as { id: string; database_id: string | null; body: string | null }[]) {
    db.query(
      "INSERT INTO search_fts (kind, id, database_id, title, body) VALUES ('record', ?, ?, ?, ?)",
    ).run(r.id, r.database_id, r.id, r.body ?? "");
  }
  db.query(
    "INSERT INTO meta (key, value) VALUES ('search_hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(max);
  return true;
}

function ftsSearch(db: Database, query: string, limit: number): SearchHit[] {
  const match = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!match) return [];
  const rows = db
    .query(
      "SELECT kind, id, database_id, title, snippet(search_fts, -1, '[', ']', '…', 10) AS snippet FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(match, limit) as {
    kind: "document" | "record";
    id: string;
    database_id: string | null;
    title: string | null;
    snippet: string;
  }[];
  return rows.map((r) => ({
    type: r.kind,
    id: r.id,
    database_id: r.database_id,
    title: r.title || undefined,
    snippet: r.snippet,
  }));
}

function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, i + q.length + 50)}…`;
}

// Substring match — robust for CJK and exact phrases where FTS tokenization misses.
function likeSearch(db: Database, query: string, limit: number): SearchHit[] {
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const out: SearchHit[] = [];
  const docs = db
    .query(
      "SELECT id, title, body, database_id FROM documents WHERE __deleted = 0 AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') LIMIT ?",
    )
    .all(like, like, limit) as {
    id: string;
    title: string | null;
    body: string | null;
    database_id: string | null;
  }[];
  for (const d of docs)
    out.push({
      type: "document",
      id: d.id,
      database_id: d.database_id,
      title: d.title ?? undefined,
      snippet: makeSnippet(d.body || d.title || "", query),
    });

  if (out.length < limit) {
    const recs = db
      .query(
        `SELECT r.id AS id, r.database_id AS database_id, group_concat(je.value, ' ') AS body
         FROM records r, json_each(r.data) je
         JOIN properties p ON p.id = je.key AND p.__deleted = 0
         WHERE r.__deleted = 0 AND p.type IN ${TEXT_TYPES}
         GROUP BY r.id HAVING body LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(like, limit - out.length) as {
      id: string;
      database_id: string | null;
      body: string | null;
    }[];
    for (const r of recs)
      out.push({
        type: "record",
        id: r.id,
        database_id: r.database_id,
        snippet: makeSnippet(r.body || "", query),
      });
  }
  return out;
}

export function search(
  db: Database,
  query: string,
  opts: { limit?: number } = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  if (ensureIndex(db)) {
    try {
      const hits = ftsSearch(db, query, limit);
      if (hits.length) return hits;
    } catch {
      // fall through to LIKE
    }
  }
  return likeSearch(db, query, limit);
}
