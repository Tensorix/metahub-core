import type { DbDriver } from "./driver.ts";
import { idKind, type Kind } from "./ids.ts";
import { MhError } from "./errors.ts";

/** Kinds reachable through the public reference resolver. `blk` is internal. */
export type PublicKind = "db" | "prop" | "rec" | "doc";

export interface Candidate {
  kind: PublicKind;
  id: string;
  label: string;
}

interface KindSpec {
  table: string;
  nameCol: string | null; // column matched by name/title (null = no name match)
  scoped: boolean; // filtered by database_id when a scope is supplied
  noun: string; // human label for "no such <noun>"
}

const SPECS: Record<PublicKind, KindSpec> = {
  db: { table: "databases", nameCol: "name", scoped: false, noun: "database" },
  prop: { table: "properties", nameCol: "name", scoped: true, noun: "property" },
  rec: { table: "records", nameCol: null, scoped: true, noun: "record" },
  doc: { table: "documents", nameCol: "title", scoped: true, noun: "document" },
};

const PUBLIC_KINDS: PublicKind[] = ["db", "prop", "rec", "doc"];

function isPublic(k: Kind | null): k is PublicKind {
  return k !== null && k !== "blk";
}

type SqlValue = string;

// '{' (0x7B) is the first code point above every char an id can contain
// ([a-z0-9_-], max 'z' = 0x7A), so [p, p+'{') is exactly the set of ids with
// prefix p under BINARY collation — a primary-key range scan, no LIKE wildcards.
const HI = "{";

/** The first text property's id for a database — a record's de-facto title.
 *  Exported: name resolution here, records.recordTitleMap, and the WebUI's
 *  relation-titles cache must all agree on the same title rule. */
export function titlePropId(db: DbDriver, databaseId: string): string | null {
  const row = db
    .query(
      "SELECT id FROM properties WHERE database_id = ? AND type = 'text' AND __deleted = 0 ORDER BY position LIMIT 1",
    )
    .get(databaseId) as { id: string } | null;
  return row?.id ?? null;
}

/** All live rows of one kind matching `ref` by id-prefix or name. */
function queryKind(
  db: DbDriver,
  kind: PublicKind,
  ref: string,
  databaseId?: string,
): Candidate[] {
  const spec = SPECS[kind];
  // Records have no name column; when scoped to a database, match/show the
  // first text property's value (its title) so "Alice Chen" resolves.
  let nameCol = spec.nameCol;
  if (kind === "rec" && databaseId) {
    const tp = titlePropId(db, databaseId);
    if (tp) nameCol = `data ->> '${tp.replace(/'/g, "''")}'`;
  }
  const labelExpr = nameCol ?? "''"; // kinds without a name show id only
  const conds: string[] = [];
  const args: SqlValue[] = [];

  // Raw prefix (covers an exact full id, and a typed prefix like "rec_log").
  conds.push("(id >= ? AND id < ?)");
  args.push(ref, ref + HI);
  // Typed slug prefix: lets a bare slug "login-bug" hit "rec_login-bug-…".
  const typed = `${kind}_${ref}`;
  conds.push("(id >= ? AND id < ?)");
  args.push(typed, typed + HI);
  // Name/title equality (case-insensitive), where the kind has a name.
  if (nameCol) {
    conds.push(`lower(${nameCol}) = lower(?)`);
    args.push(ref);
  }

  let sql = `SELECT id, ${labelExpr} AS label FROM ${spec.table} WHERE __deleted = 0 AND (${conds.join(" OR ")})`;
  if (spec.scoped && databaseId) {
    sql += " AND database_id = ?";
    args.push(databaseId);
  }

  const rows = db.query(sql).all(...args) as { id: string; label: string | null }[];
  return rows.map((r) => ({ kind, id: r.id, label: r.label ?? "" }));
}

/**
 * Every entity matching `ref`. Kind scope: an explicit `opts.kind` (the command
 * knows what it wants) wins; otherwise a typed prefix on `ref` dispatches; else
 * all public kinds are searched (the generic `mh get`). `databaseId` narrows
 * rec/doc/prop to one collection.
 */
export function resolveCandidates(
  db: DbDriver,
  ref: string,
  opts: { kind?: PublicKind; databaseId?: string } = {},
): Candidate[] {
  const kinds: PublicKind[] = opts.kind
    ? [opts.kind]
    : isPublic(idKind(ref))
      ? [idKind(ref) as PublicKind]
      : PUBLIC_KINDS;

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const k of kinds) {
    for (const c of queryKind(db, k, ref, opts.databaseId)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

function fmt(cands: Candidate[]): string {
  return cands
    .map((c) => `  ${c.id}${c.label ? "  " + c.label : ""}  (${c.kind})`)
    .join("\n");
}

/**
 * Resolve `ref` to one entity. An exact full-id match always wins (the full id
 * keeps working). Otherwise a single candidate is returned; zero throws
 * "no such …"; multiple throws a git-style ambiguity list.
 */
export function resolveEntity(
  db: DbDriver,
  ref: string,
  opts: { kind?: PublicKind; databaseId?: string } = {},
): Candidate {
  const cands = resolveCandidates(db, ref, opts);
  const exact = cands.filter((c) => c.id === ref);
  if (exact.length === 1) return exact[0]!;
  if (exact.length === 0 && cands.length === 1) return cands[0]!;

  if (cands.length === 0) {
    const noun = opts.kind ? SPECS[opts.kind].noun : "item";
    throw new MhError("not_found", `no such ${noun}: ${ref}`);
  }
  const shown = exact.length > 1 ? exact : cands;
  throw new MhError(
    "ambiguous",
    `ambiguous "${ref}" — ${shown.length} matches:\n${fmt(shown)}\n  add more characters.`,
  );
}

/** Resolve `ref` to one concrete row id. See {@link resolveEntity}. */
export function resolveRef(
  db: DbDriver,
  ref: string,
  opts: { kind?: PublicKind; databaseId?: string } = {},
): string {
  return resolveEntity(db, ref, opts).id;
}
