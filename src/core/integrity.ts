import type { Database } from "bun:sqlite";
import { emit, grouped, applyChange, CHANGE_SELECT, DOMAIN, type Change } from "./crdt.ts";
import { PROP_TYPES, type PropertyConfig } from "./properties.ts";
import type { DbDriver } from "./driver.ts";

// ---- materialization repair --------------------------------------------------
// The oplog is the source of truth; every DOMAIN table is a cache of its
// winners. A dropped/emptied/corrupted table is rebuilt by replaying the
// dataset's changes in seq order (applyChange keeps LWW per register, so the
// final state equals the converged one). Node-local, emits nothing.

/** Rebuild one replicated table from its oplog changes. Returns rows replayed. */
export function rematerializeDataset(db: DbDriver, dataset: string): number {
  const d = DOMAIN[dataset];
  if (!d) throw new Error(`not a replicated dataset: ${dataset}`);
  const changes = db
    .query(`SELECT ${CHANGE_SELECT} FROM crdt_changes WHERE dataset = ? ORDER BY seq`)
    .all(dataset) as Change[];
  db.transaction((rows: Change[]) => {
    db.query(`DELETE FROM ${d.table}`).run();
    for (const c of rows) applyChange(db, c);
  })(changes);
  return changes.length;
}

/** Rebuild every replicated table (DOMAIN) from the oplog. */
export function rematerializeAll(db: DbDriver): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ds of Object.keys(DOMAIN)) out[ds] = rematerializeDataset(db, ds);
  return out;
}

// Hub-wide logical invariants. The schema is deliberately weak (primary keys
// only, no FK/UNIQUE) because the CRDT is a per-field LWW oplog: cell writes can
// arrive before their parent row (out-of-order sync), concurrent same-name
// creates must both survive to converge, and replay must stay idempotent — all
// of which SQL constraints would break. Instead we enforce invariants logically
// and eventually-consistently here.
//
// Two guarantees make this safe under sync:
//   1. Repair acts on TOMBSTONES, never on absence. A reference whose target is
//      merely missing may be a forward reference still in flight; only a target
//      explicitly marked __deleted = 1 is treated as broken. (Read paths already
//      hide absent targets via their __deleted = 0 filters.)
//   2. Repair is a deterministic, idempotent function of the converged
//      materialized state: every node computes the same fixes, winners use the
//      total order (created_hlc, id), and re-running it is a no-op (fixpoint).
//      All fixes go through emit() so they replicate like any other change.

export type IssueCategory =
  | "broken_ref"
  | "orphan_cell"
  | "dead_cell_ref"
  | "dup_path"
  | "dup_name"
  | "parent_cycle"
  | "bad_config";

export interface Issue {
  category: IssueCategory;
  entity: string;
  id: string;
  detail: string;
  /** Whether repairHub() will act on this issue (vs. report-only). */
  fixable: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  total: number;
  counts: Record<string, number>;
  issues: Issue[];
}

export interface RepairResult {
  applied: number;
  fixed: Record<string, number>;
  /** Issues left after repair — only report-only categories should remain. */
  remaining: IntegrityReport;
}

// ---- weak reference rules --------------------------------------------------
// Each source table column points (weakly) at a target table. `srcTable` doubles
// as the emit() dataset name for all of these.

type RefFix = "tombstone-src" | "null-fk";

interface RefRule {
  srcTable: string;
  fk: string;
  tgtTable: string;
  fix: RefFix;
}

const REF_RULES: readonly RefRule[] = [
  // A property/record without its database is meaningless — tombstone it.
  { srcTable: "properties", fk: "database_id", tgtTable: "databases", fix: "tombstone-src" },
  { srcTable: "records", fk: "database_id", tgtTable: "databases", fix: "tombstone-src" },
  // A document's database_id is an optional scope; detach so content survives.
  { srcTable: "documents", fk: "database_id", tgtTable: "databases", fix: "null-fk" },
  // A child of a deleted document survives as a root (non-destructive).
  { srcTable: "documents", fk: "parent_id", tgtTable: "documents", fix: "null-fk" },
  // Blocks/files are derived content of their doc/site — tombstone them.
  { srcTable: "doc_blocks", fk: "doc_id", tgtTable: "documents", fix: "tombstone-src" },
  { srcTable: "site_files", fk: "site_id", tgtTable: "sites", fix: "tombstone-src" },
];

/** Live source rows whose non-null fk points at a TOMBSTONED target. */
function brokenRefRows(db: Database, r: RefRule): { id: string; ref: string }[] {
  return db
    .query(
      `SELECT s.id AS id, s.${r.fk} AS ref FROM ${r.srcTable} s
       JOIN ${r.tgtTable} t ON t.id = s.${r.fk} AND t.__deleted = 1
       WHERE s.__deleted = 0 AND s.${r.fk} IS NOT NULL
       ORDER BY s.id`,
    )
    .all() as { id: string; ref: string }[];
}

function detectBrokenRefs(db: Database): Issue[] {
  const out: Issue[] = [];
  for (const r of REF_RULES) {
    for (const row of brokenRefRows(db, r)) {
      out.push({
        category: "broken_ref",
        entity: r.srcTable,
        id: row.id,
        detail: `${r.fk} → deleted ${r.tgtTable} ${row.ref} (${r.fix === "tombstone-src" ? "tombstone" : `clear ${r.fk}`})`,
        fixable: true,
      });
    }
  }
  return out;
}

function repairBrokenRefs(db: Database): number {
  let n = 0;
  for (const r of REF_RULES) {
    for (const row of brokenRefRows(db, r)) {
      if (r.fix === "tombstone-src") emit(db, r.srcTable, row.id, "__deleted", 1);
      else emit(db, r.srcTable, row.id, r.fk, null);
      n++;
    }
  }
  return n;
}

// ---- orphan cells ----------------------------------------------------------
// A record's data JSON is keyed by property id. When a property is tombstoned
// its cells are dead weight (read paths already skip them). Remove the key
// outright — emit(undefined) materializes to json_remove, so re-validation
// finds nothing (fixpoint). Absent (not tombstoned) property keys are tolerated:
// they may be forward references to a property still in flight.

function orphanCellRows(db: Database): { rec: string; prop: string }[] {
  return db
    .query(
      `SELECT r.id AS rec, j.key AS prop
       FROM records r, json_each(coalesce(r.data, '{}')) j
       JOIN properties p ON p.id = j.key AND p.__deleted = 1
       WHERE r.__deleted = 0
       ORDER BY r.id, j.key`,
    )
    .all() as { rec: string; prop: string }[];
}

function detectOrphanCells(db: Database): Issue[] {
  return orphanCellRows(db).map((row) => ({
    category: "orphan_cell" as const,
    entity: "records",
    id: row.rec,
    detail: `cell for deleted property ${row.prop}`,
    fixable: true,
  }));
}

function repairOrphanCells(db: Database): number {
  const rows = orphanCellRows(db);
  for (const row of rows) emit(db, "records", row.rec, row.prop, undefined); // json_remove
  return rows.length;
}

// ---- dead cell references --------------------------------------------------
// relation/doc cells hold arrays of target ids (records / documents). Deleting
// a target leaves its id dangling in every referencing array forever — no read
// path hides it. Strip ids whose target is TOMBSTONED (absence may be a forward
// reference still in flight) and emit the filtered array; an array that loses
// every element becomes [] (the same shape coerce(null) writes). Targets are
// looked up by id globally, not via config.database — ids are globally unique
// and a retargeted relation must not resurrect old links.

interface DeadCellGroup {
  rec: string;
  prop: string;
  tgtTable: "records" | "documents";
  dead: string[];
}

function deadCellRefRows(db: Database): DeadCellGroup[] {
  const props = db
    .query(
      "SELECT id, type FROM properties WHERE __deleted = 0 AND type IN ('relation', 'doc') ORDER BY id",
    )
    .all() as { id: string; type: string }[];
  const out: DeadCellGroup[] = [];
  for (const p of props) {
    const tgtTable = p.type === "relation" ? "records" : "documents";
    const pid = p.id.replace(/'/g, "''");
    // `->` (not `->>`) so scalar cells stay valid JSON for json_type/json_each.
    const rows = db
      .query(
        `SELECT r.id AS rec, j.value AS dead
         FROM records r, json_each(r.data -> '${pid}') j
         JOIN ${tgtTable} t ON t.id = j.value AND t.__deleted = 1
         WHERE r.__deleted = 0 AND json_type(r.data -> '${pid}') = 'array'
         ORDER BY r.id, j.value`,
      )
      .all() as { rec: string; dead: string }[];
    let cur: DeadCellGroup | null = null;
    for (const row of rows) {
      if (!cur || cur.rec !== row.rec) {
        cur = { rec: row.rec, prop: p.id, tgtTable, dead: [] };
        out.push(cur);
      }
      cur.dead.push(row.dead);
    }
  }
  return out;
}

function detectDeadCellRefs(db: Database): Issue[] {
  return deadCellRefRows(db).map((g) => ({
    category: "dead_cell_ref" as const,
    entity: "records",
    id: g.rec,
    detail: `cell ${g.prop} references deleted ${g.tgtTable === "records" ? "record" : "document"}: ${g.dead.join(", ")}`,
    fixable: true,
  }));
}

function repairDeadCellRefs(db: Database): number {
  const groups = deadCellRefRows(db);
  for (const g of groups) {
    const row = db.query("SELECT data FROM records WHERE id = ?").get(g.rec) as
      | { data: string | null }
      | null;
    if (!row) continue;
    const data = JSON.parse(row.data || "{}") as Record<string, unknown>;
    const arr = data[g.prop];
    if (!Array.isArray(arr)) continue; // changed underneath us — next pass re-scans
    const deadSet = new Set(g.dead);
    emit(db, "records", g.rec, g.prop, arr.filter((v) => !deadSet.has(String(v))));
  }
  return groups.length;
}

// ---- duplicate file paths (route dedup) ------------------------------------
// Two nodes can concurrently upload to the same (site_id, path), producing two
// live rows. Reads pick the earliest by (created_hlc, id) (getFileForServe /
// fileIdFor both ORDER BY created_hlc LIMIT 1), so keep that winner and tombstone
// the redundant losers to match read behavior deterministically.

function dupPathLosers(db: Database): { id: string }[] {
  const rows = db
    .query(
      `SELECT id, site_id, path FROM site_files
       WHERE __deleted = 0 AND site_id IS NOT NULL AND path IS NOT NULL
       ORDER BY site_id, path, created_hlc, id`,
    )
    .all() as { id: string; site_id: string; path: string }[];
  const losers: { id: string }[] = [];
  let group: string | null = null;
  for (const r of rows) {
    const key = `${r.site_id} ${r.path}`;
    if (key === group) losers.push({ id: r.id });
    else group = key;
  }
  return losers;
}

function detectDupPaths(db: Database): Issue[] {
  return dupPathLosers(db).map((row) => ({
    category: "dup_path" as const,
    entity: "site_files",
    id: row.id,
    detail: "redundant duplicate (site_id, path); loser tombstoned",
    fixable: true,
  }));
}

function repairDupPaths(db: Database): number {
  const losers = dupPathLosers(db);
  for (const row of losers) emit(db, "site_files", row.id, "__deleted", 1);
  return losers.length;
}

// ---- document parent cycles ------------------------------------------------
// Local edits guard against cycles (documents.updateDocument), but two nodes can
// each set a parent and merge into a cycle. Break each cycle deterministically
// at its (created_hlc, id) maximum member by clearing that node's parent_id.

interface CycleInfo {
  cycles: string[][];
  hlc: Map<string, string | null>;
}

function detectParentCycles(db: Database): CycleInfo {
  const rows = db
    .query(
      `SELECT d.id AS id, d.parent_id AS parent, d.created_hlc AS hlc
       FROM documents d
       WHERE d.__deleted = 0 AND d.parent_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM documents p WHERE p.id = d.parent_id AND p.__deleted = 0)
       ORDER BY d.id`,
    )
    .all() as { id: string; parent: string; hlc: string | null }[];

  const parent = new Map(rows.map((r) => [r.id, r.parent]));
  const hlc = new Map(rows.map((r) => [r.id, r.hlc]));
  const seen = new Set<string>();
  const cycles: string[][] = [];

  for (const start of parent.keys()) {
    if (seen.has(start)) continue;
    const path: string[] = [];
    const pos = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur != null && parent.has(cur) && !seen.has(cur)) {
      if (pos.has(cur)) {
        cycles.push(path.slice(pos.get(cur)!));
        break;
      }
      pos.set(cur, path.length);
      path.push(cur);
      cur = parent.get(cur);
    }
    for (const n of path) seen.add(n);
  }
  return { cycles, hlc };
}

/** Compare (hlc, id); a null hlc sorts lowest. Returns true if a ≥ b. */
function geHlcId(hlc: Map<string, string | null>, a: string, b: string): boolean {
  const ha = hlc.get(a) ?? "";
  const hb = hlc.get(b) ?? "";
  if (ha !== hb) return ha > hb;
  return a >= b;
}

function detectCycleIssues(db: Database): Issue[] {
  const { cycles } = detectParentCycles(db);
  return cycles.map((cyc) => ({
    category: "parent_cycle" as const,
    entity: "documents",
    id: [...cyc].sort()[0]!,
    detail: `parent cycle: ${[...cyc].sort().join(" → ")}`,
    fixable: true,
  }));
}

function repairParentCycles(db: Database): number {
  const { cycles, hlc } = detectParentCycles(db);
  for (const cyc of cycles) {
    const brk = cyc.reduce((a, b) => (geHlcId(hlc, a, b) ? a : b));
    emit(db, "documents", brk, "parent_id", null);
  }
  return cycles.length;
}

// ---- duplicate names (report-only) -----------------------------------------
// Cosmetic for identity (rows key by id), but it makes name-based resolution
// ambiguous. We never auto-rename or delete user content — just surface it.

function detectDupNames(db: Database): Issue[] {
  const out: Issue[] = [];

  const props = db
    .query(
      `SELECT database_id AS db, lower(name) AS n, count(*) AS c, group_concat(id) AS ids
       FROM properties
       WHERE __deleted = 0 AND name IS NOT NULL AND database_id IS NOT NULL
       GROUP BY database_id, lower(name) HAVING c > 1
       ORDER BY database_id, n`,
    )
    .all() as { db: string; n: string; c: number; ids: string }[];
  for (const r of props)
    out.push({
      category: "dup_name",
      entity: "properties",
      id: r.ids.split(",").sort()[0]!,
      detail: `${r.c} properties named "${r.n}" in database ${r.db}: ${r.ids}`,
      fixable: false,
    });

  const dbs = db
    .query(
      `SELECT lower(name) AS n, count(*) AS c, group_concat(id) AS ids
       FROM databases WHERE __deleted = 0 AND name IS NOT NULL
       GROUP BY lower(name) HAVING c > 1 ORDER BY n`,
    )
    .all() as { n: string; c: number; ids: string }[];
  for (const r of dbs)
    out.push({
      category: "dup_name",
      entity: "databases",
      id: r.ids.split(",").sort()[0]!,
      detail: `${r.c} databases named "${r.n}": ${r.ids}`,
      fixable: false,
    });

  return out;
}

// ---- invalid property type / config (report-only) --------------------------

function configIssue(type: string, config: PropertyConfig | null): string | null {
  if (!PROP_TYPES.has(type)) return `unknown property type: ${type}`;
  if (type === "select" || type === "multi_select") {
    const opts = config?.options;
    if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === "string"))
      return `${type} missing config.options: string[]`;
  }
  if (type === "relation" && typeof config?.database !== "string")
    return "relation missing config.database";
  return null;
}

function detectBadConfig(db: Database): Issue[] {
  const rows = db
    .query("SELECT id, type, config FROM properties WHERE __deleted = 0 ORDER BY id")
    .all() as { id: string; type: string; config: string | null }[];
  const out: Issue[] = [];
  for (const r of rows) {
    let config: PropertyConfig | null = null;
    try {
      config = r.config ? (JSON.parse(r.config) as PropertyConfig) : null;
    } catch {
      out.push({ category: "bad_config", entity: "properties", id: r.id, detail: "config is not valid JSON", fixable: false });
      continue;
    }
    const problem = configIssue(r.type, config);
    if (problem) out.push({ category: "bad_config", entity: "properties", id: r.id, detail: problem, fixable: false });
  }
  return out;
}

// ---- public API ------------------------------------------------------------

/** Read-only scan of all logical invariants. Never mutates. */
export function validateHub(db: Database): IntegrityReport {
  const issues = [
    ...detectBrokenRefs(db),
    ...detectOrphanCells(db),
    ...detectDeadCellRefs(db),
    ...detectDupPaths(db),
    ...detectCycleIssues(db),
    ...detectDupNames(db),
    ...detectBadConfig(db),
  ];
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.category] = (counts[i.category] ?? 0) + 1;
  return { ok: issues.length === 0, total: issues.length, counts, issues };
}

function repairPass(db: Database): { applied: number; fixed: Record<string, number> } {
  const fixed: Record<string, number> = {};
  const bump = (cat: string, n: number) => {
    if (n) fixed[cat] = (fixed[cat] ?? 0) + n;
  };
  bump("broken_ref", repairBrokenRefs(db));
  bump("orphan_cell", repairOrphanCells(db));
  bump("dead_cell_ref", repairDeadCellRefs(db));
  bump("dup_path", repairDupPaths(db));
  bump("parent_cycle", repairParentCycles(db));
  const applied = Object.values(fixed).reduce((a, b) => a + b, 0);
  return { applied, fixed };
}

/**
 * Deterministically repair every fixable invariant, emitting convergent changes.
 * Idempotent: runs to a fixpoint, so a second call (or the same state on another
 * node) is a no-op. Report-only categories (dup_name, bad_config) are returned in
 * `remaining` for human resolution, never auto-changed.
 */
export const repairHub = grouped(function repairHub(db: Database): RepairResult {
  const fixed: Record<string, number> = {};
  let applied = 0;
  // A fix can expose a follow-on (e.g. tombstoning a property orphans its cells),
  // so iterate to a fixpoint. Bounded as a safety net against pathological input.
  for (let i = 0; i < 20; i++) {
    const pass = repairPass(db);
    if (pass.applied === 0) break;
    applied += pass.applied;
    for (const [cat, n] of Object.entries(pass.fixed)) fixed[cat] = (fixed[cat] ?? 0) + n;
  }
  return { applied, fixed, remaining: validateHub(db) };
}, "repair");
