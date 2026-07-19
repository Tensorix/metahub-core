// Table×operation authorization primitives for guest data access (public sites
// and share links). PORTABLE, driver-only — no node:/bun: imports — because the
// same checks must run wherever guest writes are accepted: this node's server
// (sync/grants-routes.ts), a future Durable Object room, and the write-inbox
// ingest isolation layer (checkGuestChanges).
//
// Trust model: a GrantSet may arrive from an untrusted peer (sites.public_grants
// is a synced CRDT register — any peer can write arbitrary strings into it), so
// parseGrantSet is DEFAULT-DENY: any malformed input yields the empty set, which
// authorizes nothing. Local writes go through validateGrantSetInput, which
// throws loudly instead.
//
// Anti-enumeration: authorizeDbRef/authorizeRecord answer "not granted" and
// "does not exist" with the SAME MhError("auth") — an anonymous caller can
// never probe which databases/records exist beyond what it was granted.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
import { getDatabase, type DatabaseRow } from "./databases.ts";
import { listProperties, type PropertyRow } from "./properties.ts";
import {
  coerce,
  resolveData,
  createRecordPrepared,
  updateRecordPrepared,
  getRecord,
  type PreparedRecordCell,
  type RecordRow,
} from "./records.ts";
import { withNodeId, type Change } from "./crdt.ts";

// ---- grant model ---------------------------------------------------------------

/** delete NEVER enters this enum — anonymous/guest deletion is not a thing. */
export type GrantOp = "read" | "create" | "update";

export interface GrantTable {
  /** database ID (never a name — names rename, grants must not follow). */
  db: string;
  ops: GrantOp[];
}

export interface GrantSet {
  v: 1;
  tables: GrantTable[];
}

const GRANT_OPS: readonly GrantOp[] = ["read", "create", "update"];

function emptySet(): GrantSet {
  return { v: 1, tables: [] };
}

function isGrantOp(x: unknown): x is GrantOp {
  return typeof x === "string" && (GRANT_OPS as readonly string[]).includes(x);
}

/** Canonicalize: ops deduped in GRANT_OPS order, duplicate dbs merged (ops
 *  unioned), tables sorted by db id, empty-op tables dropped. */
function normalizeSet(tables: GrantTable[]): GrantSet {
  const byDb = new Map<string, Set<GrantOp>>();
  for (const t of tables) {
    const ops = byDb.get(t.db) ?? new Set<GrantOp>();
    for (const op of t.ops) ops.add(op);
    byDb.set(t.db, ops);
  }
  const out: GrantTable[] = [];
  for (const [dbId, ops] of byDb) {
    const ordered = GRANT_OPS.filter((op) => ops.has(op));
    if (ordered.length) out.push({ db: dbId, ops: ordered });
  }
  out.sort((a, b) => (a.db < b.db ? -1 : a.db > b.db ? 1 : 0));
  return { v: 1, tables: out };
}

/**
 * Parse a stored grants register. DEFAULT-DENY: null/undefined, broken JSON, a
 * version other than 1, unknown ops, or any malformed shape (the "five
 * poisons") all yield the EMPTY set — a poisoned register closes the whole
 * guest surface instead of opening any part of it.
 */
export function parseGrantSet(raw: string | null | undefined): GrantSet {
  if (!raw) return emptySet();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySet();
  }
  try {
    return validateGrantSetInput(parsed);
  } catch {
    return emptySet();
  }
}

/**
 * Strictly validate a caller-supplied GrantSet (CLI/WebUI writes) — the loud
 * twin of parseGrantSet's silent default-deny. Returns the normalized set;
 * throws MhError("invalid_input") on any malformation.
 */
export function validateGrantSetInput(input: unknown): GrantSet {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new MhError("invalid_input", "grants must be an object {v:1, tables:[...]}");
  const obj = input as { v?: unknown; tables?: unknown };
  if (obj.v !== 1) throw new MhError("invalid_input", "grants version must be 1");
  if (!Array.isArray(obj.tables))
    throw new MhError("invalid_input", "grants.tables must be an array");
  const tables: GrantTable[] = [];
  for (const t of obj.tables) {
    if (typeof t !== "object" || t === null)
      throw new MhError("invalid_input", "each grant table must be an object {db, ops}");
    const { db, ops } = t as { db?: unknown; ops?: unknown };
    if (typeof db !== "string" || !db)
      throw new MhError("invalid_input", "grant table `db` must be a database id");
    if (!Array.isArray(ops) || !ops.every(isGrantOp))
      throw new MhError(
        "invalid_input",
        `grant ops must be a subset of ${GRANT_OPS.join("|")} (delete is never grantable)`,
      );
    tables.push({ db, ops: ops as GrantOp[] });
  }
  return normalizeSet(tables);
}

/** Canonical serialized form for storage (register value / shares.grants). */
export function serializeGrantSet(set: GrantSet): string {
  return JSON.stringify(normalizeSet(set.tables));
}

/**
 * Parse the CLI grant spec syntax `<db>:<op>[,<op>...]`, e.g. "tasks:read,create".
 * `db` comes back as the raw ref — the caller resolves it to a database ID.
 */
export function parseGrantSpec(spec: string): { db: string; ops: GrantOp[] } {
  const colon = spec.lastIndexOf(":");
  if (colon <= 0 || colon === spec.length - 1)
    throw new MhError("invalid_input", `grant spec must look like <db>:read,create — got ${JSON.stringify(spec)}`);
  const db = spec.slice(0, colon);
  const ops = spec
    .slice(colon + 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ops.length === 0)
    throw new MhError("invalid_input", `grant spec has no ops: ${JSON.stringify(spec)}`);
  for (const op of ops) {
    if (!isGrantOp(op))
      throw new MhError(
        "invalid_input",
        `unknown grant op ${JSON.stringify(op)} — allowed: ${GRANT_OPS.join(", ")}`,
      );
  }
  return { db, ops: [...new Set(ops as GrantOp[])] };
}

/** The grant entry for one database id, if any. */
export function grantFor(set: GrantSet, dbId: string): GrantTable | undefined {
  return set.tables.find((t) => t.db === dbId);
}

export function grantAllows(set: GrantSet, dbId: string, op: GrantOp): boolean {
  return grantFor(set, dbId)?.ops.includes(op) ?? false;
}

/** True when any table grants a write op — the trigger for minting a guest
 *  node id on shares (attribution needs an author identity). */
export function grantSetHasWrite(set: GrantSet): boolean {
  return set.tables.some((t) => t.ops.some((op) => op !== "read"));
}

// ---- principals -----------------------------------------------------------------

/** Who is acting through the granted surface. The kind gates the relation-
 *  property policy (see assertGuestPayload); guestNode is the synthetic node id
 *  every write is attributed to (per-visitor, so rollback can target one
 *  author). */
export interface GrantPrincipal {
  kind: "public" | "share";
  guestNode: string;
}

/**
 * The anonymous-public guest node id, DERIVED per (site × serving node) and
 * never stored: `gp-<site8>-<node8>`. Two servers must NOT share one guest id —
 * both would mint HLCs for the same register under the same node segment and
 * the oplog UNIQUE would silently drop one write (data loss). Derivation keeps
 * per-source bulk rollback possible (LIKE 'gp-<site8>-%').
 */
export function publicGuestNode(siteId: string, nodeId: string): string {
  return `gp-${siteId.slice(-8)}-${nodeId.slice(0, 8)}`;
}

// ---- authorization ---------------------------------------------------------------

/** The one uniform refusal — unauthorized and nonexistent are indistinguishable. */
function deny(): MhError {
  return new MhError("auth", "unauthorized");
}

/**
 * Resolve a database ref (id or name) WITHIN the granted set only, and require
 * `op`. Any failure — unknown ref, existing-but-ungranted database, granted
 * database missing the op — throws the identical MhError("auth"): resolution
 * never consults ungranted databases, so this endpoint is useless as an
 * existence oracle. A name matching several granted databases is the one
 * distinguishable error (ambiguous): it only exposes what the caller was
 * already granted.
 */
export function authorizeDbRef(
  db: DbDriver,
  set: GrantSet,
  dbRef: string,
  op: GrantOp,
): DatabaseRow {
  const matches: { row: DatabaseRow; table: GrantTable }[] = [];
  for (const table of set.tables) {
    const row = getDatabase(db, table.db);
    if (!row) continue; // granted id no longer exists — nothing to serve
    if (row.id === dbRef || row.name.toLowerCase() === dbRef.toLowerCase())
      matches.push({ row, table });
  }
  // An exact id match wins over name collisions.
  const exact = matches.find((m) => m.row.id === dbRef);
  const hit = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!hit) {
    if (matches.length > 1)
      throw new MhError("ambiguous", `"${dbRef}" matches ${matches.length} granted databases; use a database id`);
    throw deny();
  }
  if (!hit.table.ops.includes(op)) throw deny();
  return hit.row;
}

/**
 * Load a record by id and require `op` on its database. Nonexistent record and
 * ungranted record answer identically (MhError("auth")).
 */
export function authorizeRecord(
  db: DbDriver,
  set: GrantSet,
  recordId: string,
  op: GrantOp,
): RecordRow {
  const rec = getRecord(db, recordId);
  if (!rec || !grantAllows(set, rec.database_id, op)) throw deny();
  return rec;
}

// ---- payload guardrails ------------------------------------------------------------

export interface PayloadLimits {
  /** Total serialized cell bytes per write. */
  maxBodyBytes: number;
  /** Serialized bytes of one cell value. */
  maxValueBytes: number;
  /** Cells per write. */
  maxCells: number;
  /** Live rows per table — creates refuse beyond this (spam ceiling). */
  maxRows: number;
}

export const GUEST_LIMITS: PayloadLimits = {
  maxBodyBytes: 64 * 1024,
  maxValueBytes: 8 * 1024,
  maxCells: 64,
  maxRows: 10_000,
};

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function liveRowCount(db: DbDriver, databaseId: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM records WHERE database_id = ? AND __deleted = 0")
      .get(databaseId) as { n: number }
  ).n;
}

/** Relation policy by principal: public visitors never write relations (a
 *  relation resolve probes the target database — an enumeration oracle);
 *  share guests may, but only into databases that are themselves in the set. */
function assertRelationAllowed(
  set: GrantSet,
  principalKind: GrantPrincipal["kind"],
  prop: PropertyRow,
): void {
  if (principalKind === "public")
    throw new MhError("invalid_input", `${prop.name}: relation properties are not writable anonymously`);
  const target = prop.config?.database;
  if (!target || !grantFor(set, target))
    throw new MhError("invalid_input", `${prop.name}: relation target database is not in this share's grants`);
}

/**
 * Guest payload guardrails, run BEFORE any write: property resolution,
 * coercion, cell count, per-value and total size, and relation policy. Returns
 * the prepared cells so the actual mutator does not resolve/coerce them again.
 *
 * The stateful create capacity check is separate: an exact idempotent replay
 * must still succeed after the table reaches its row ceiling.
 */
export function assertGuestPayload(
  db: DbDriver,
  set: GrantSet,
  principal: GrantPrincipal,
  database: DatabaseRow,
  values: Record<string, unknown>,
  opts: { limits?: PayloadLimits } = {},
): PreparedRecordCell[] {
  const limits = opts.limits ?? GUEST_LIMITS;
  const entries = Object.entries(values);
  if (entries.length > limits.maxCells)
    throw new MhError("invalid_input", `too many cells (max ${limits.maxCells})`);

  const props = listProperties(db, database.id);
  const resolved = resolveData(props, values).map(({ prop, value }) => ({
    prop,
    value: coerce(db, prop, value),
  })); // unknown keys / ambiguous names / invalid values throw here

  let total = 0;
  for (const { prop, value } of resolved) {
    const size = utf8Len(JSON.stringify(value ?? null));
    if (size > limits.maxValueBytes)
      throw new MhError("invalid_input", `${prop.name}: value too large (max ${limits.maxValueBytes} bytes)`);
    total += size;
    if (prop.type === "relation" && value != null && !(Array.isArray(value) && value.length === 0))
      assertRelationAllowed(set, principal.kind, prop);
  }
  if (total > limits.maxBodyBytes)
    throw new MhError("invalid_input", `payload too large (max ${limits.maxBodyBytes} bytes)`);

  return resolved;
}

export function assertGuestCreateCapacity(
  db: DbDriver,
  database: DatabaseRow,
  limits: PayloadLimits = GUEST_LIMITS,
): void {
  if (liveRowCount(db, database.id) >= limits.maxRows)
    throw new MhError("invalid_input", `table is full (guest writes cap at ${limits.maxRows} rows)`);
}

// ---- guest write wrappers ------------------------------------------------------------

/** Authorized, guarded, guest-attributed record creation. */
export function guestCreateRecord(
  db: DbDriver,
  set: GrantSet,
  principal: GrantPrincipal,
  dbRef: string,
  values: Record<string, unknown>,
  limits?: PayloadLimits,
): RecordRow {
  const database = authorizeDbRef(db, set, dbRef, "create");
  const cells = assertGuestPayload(db, set, principal, database, values, { limits });
  assertGuestCreateCapacity(db, database, limits);
  return withNodeId(principal.guestNode, () => createRecordPrepared(db, database, cells));
}

/** Authorized, guarded, guest-attributed record update (any row of a granted
 *  table — aligned with share-edit semantics; `update:own` is a non-goal v1). */
export function guestUpdateRecord(
  db: DbDriver,
  set: GrantSet,
  principal: GrantPrincipal,
  recordId: string,
  values: Record<string, unknown>,
  limits?: PayloadLimits,
): RecordRow {
  const rec = authorizeRecord(db, set, recordId, "update");
  const database = getDatabase(db, rec.database_id);
  if (!database) throw deny();
  const cells = assertGuestPayload(db, set, principal, database, values, { limits });
  return withNodeId(principal.guestNode, () => updateRecordPrepared(db, recordId, cells));
}

// ---- op-level validation (inbox ingest isolation layer) ----------------------------

/** Record meta columns a guest op may legitimately carry on a create. */
const GUEST_META_COLS = new Set(["database_id", "created_hlc", "order_key"]);

/** Well-formed HLC string: `<digits>-<hex>-<node>`. Guards the numeric millis
 *  prefix so a NaN-parsing HLC can never reach ingest/observeHlc (clock-poison
 *  defense mirrored in drop-protocol's clamp and hlc.observeHlc). */
const GUEST_HLC_RE = /^\d+-[0-9a-fA-F]+-.+$/;

/** Property types coerce() knows how to validate. Anything else (including any
 *  future blob-carrying type) is REFUSED — an unvalidatable value must never
 *  ride a guest op into the oplog (dangling-hash / poisoning risk). Exported
 *  as the guest-writable allowlist (drop-wire publishes only these properties
 *  into mh-drop.json's offline schema). */
export const GUEST_COERCIBLE_TYPES: ReadonlySet<string> = new Set([
  "text",
  "url",
  "date",
  "number",
  "checkbox",
  "select",
  "multi_select",
  "relation",
]);

/**
 * Validate a batch of PRE-SIGNED guest ops (Change rows authored by a
 * viewer/site page under its guest node id) before ingest — the write-inbox
 * isolation layer (spike ⑨ gap 1). Throws on the first violation; a valid
 * batch returns silently. Checks, per change:
 *   - dataset is exactly "records" (nothing else is guest-writable);
 *   - node_id AND the HLC node segment equal `guestNode`;
 *   - no tombstones (__deleted — delete is never grantable);
 * and per row (changes grouped by row_id):
 *   - the target database is resolvable (existing row, or the group's own
 *     database_id op) and granted: update for existing rows, create for new
 *     ones — so a create-only grant refuses ops against an existing row_id;
 *   - a database_id op must name the granted target (no cross-db moves);
 *   - every cell column is a live property of that database, of a coercible
 *     type, and its value passes coerce(); relations additionally require the
 *     target database to be in the set;
 *   - per-value / per-row / total size limits (GUEST_LIMITS);
 *   - creates respect the per-table row ceiling.
 * HLC clamping deliberately does NOT live here — it belongs to the ingest/sync
 * layer (clock hygiene, not authorization).
 */
export function checkGuestChanges(
  db: DbDriver,
  set: GrantSet,
  guestNode: string,
  changes: Change[],
  // A write-inbox drop is always a site public_grants surface, so public is the
  // right default; threaded explicitly so a future share/room op-ingest caller
  // gets the correct relation policy (public forbids relations — oracle guard).
  principalKind: GrantPrincipal["kind"] = "public",
  limits: PayloadLimits = GUEST_LIMITS,
): void {
  if (!guestNode) throw new MhError("auth", "unauthorized");
  const byRow = new Map<string, Change[]>();
  let totalBytes = 0;

  for (const c of changes) {
    if (c.dataset !== "records")
      throw new MhError("invalid_input", `guest ops may only touch records (got dataset ${JSON.stringify(c.dataset)})`);
    if (c.node_id !== guestNode || !c.hlc.endsWith("-" + guestNode))
      throw new MhError("auth", "unauthorized");
    if (!GUEST_HLC_RE.test(c.hlc))
      throw new MhError("invalid_input", "malformed HLC");
    if (c.col === "__deleted")
      throw new MhError("invalid_input", "guest ops may not delete");
    totalBytes += utf8Len(c.value ?? "");
    const group = byRow.get(c.row_id);
    if (group) group.push(c);
    else byRow.set(c.row_id, [c]);
  }
  if (totalBytes > limits.maxBodyBytes)
    throw new MhError("invalid_input", `payload too large (max ${limits.maxBodyBytes} bytes)`);

  for (const [rowId, group] of byRow) {
    if (group.length > limits.maxCells + GUEST_META_COLS.size)
      throw new MhError("invalid_input", `too many cells for one row (max ${limits.maxCells})`);

    const existing = db
      .query("SELECT database_id FROM records WHERE id = ? AND __deleted = 0")
      .get(rowId) as { database_id: string | null } | null;
    const dbIdOp = group.find((c) => c.col === "database_id");
    const declaredDb = dbIdOp?.value != null ? (JSON.parse(dbIdOp.value) as unknown) : undefined;

    let targetDb: string;
    if (existing?.database_id) {
      // Existing row → this is an update; the grant must include update, and a
      // create-only grant refuses the row outright.
      if (!grantAllows(set, existing.database_id, "update")) throw deny();
      if (declaredDb !== undefined && declaredDb !== existing.database_id)
        throw new MhError("invalid_input", "guest ops may not move a record across databases");
      targetDb = existing.database_id;
    } else {
      // New row → create. It must declare its database, and that db must grant it.
      if (typeof declaredDb !== "string" || !declaredDb)
        throw new MhError("invalid_input", `new row ${rowId} carries no database_id`);
      if (!grantAllows(set, declaredDb, "create")) throw deny();
      if (liveRowCount(db, declaredDb) >= limits.maxRows)
        throw new MhError("invalid_input", `table is full (guest writes cap at ${limits.maxRows} rows)`);
      targetDb = declaredDb;
    }

    const props = listProperties(db, targetDb);
    for (const c of group) {
      if (GUEST_META_COLS.has(c.col)) {
        if (c.col === "created_hlc" && c.value != null && typeof JSON.parse(c.value) !== "string")
          throw new MhError("invalid_input", "created_hlc must be a string");
        continue;
      }
      const prop = props.find((p) => p.id === c.col);
      if (!prop)
        throw new MhError("invalid_input", `unknown column ${JSON.stringify(c.col)} for this database`);
      if (!GUEST_COERCIBLE_TYPES.has(prop.type))
        throw new MhError("invalid_input", `${prop.name}: property type ${prop.type} is not guest-writable`);
      if (utf8Len(c.value ?? "") > limits.maxValueBytes)
        throw new MhError("invalid_input", `${prop.name}: value too large (max ${limits.maxValueBytes} bytes)`);
      const value = c.value == null ? null : (JSON.parse(c.value) as unknown);
      if (prop.type === "relation" && value != null && !(Array.isArray(value) && value.length === 0))
        assertRelationAllowed(set, principalKind, prop);
      coerce(db, prop, value); // throws invalid_input on type mismatch
    }
  }
}
