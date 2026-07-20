import type { DbDriver } from "../driver.ts";

const META_KEY = "site_publish_rollbacks";
const STATE_META_KEY = "site_publish_states";

export interface SitePublishState {
  siteId: string;
  targetBase: string;
  url: string;
  status: "ready" | "syncing";
  updatedAt: number;
}

/** Node-local safety record: a private rollback has been emitted locally but
 * the target peer has not yet acknowledged a cursor that includes it. */
export interface PendingSiteRollback {
  siteId: string;
  peerUrl: string;
  targetUrl: string;
  requiredSeq: number;
  createdAt: number;
  lastError: string;
}

function read(db: DbDriver): PendingSiteRollback[] {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(META_KEY) as
    | { value: string }
    | null;
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PendingSiteRollback =>
        !!x &&
        typeof x.siteId === "string" &&
        typeof x.peerUrl === "string" &&
        typeof x.targetUrl === "string" &&
        Number.isFinite(x.requiredSeq) &&
        Number.isFinite(x.createdAt) &&
        typeof x.lastError === "string",
    );
  } catch {
    return [];
  }
}

function write(db: DbDriver, rows: PendingSiteRollback[]): void {
  if (rows.length === 0) {
    db.query("DELETE FROM meta WHERE key = ?").run(META_KEY);
    return;
  }
  db.query(
    "INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(META_KEY, JSON.stringify(rows));
}

export function listPendingSiteRollbacks(db: DbDriver): PendingSiteRollback[] {
  return read(db);
}

export function getPendingSiteRollback(
  db: DbDriver,
  siteId: string,
  peerUrl: string,
): PendingSiteRollback | null {
  return read(db).find((x) => x.siteId === siteId && x.peerUrl === peerUrl) ?? null;
}

export function putPendingSiteRollback(
  db: DbDriver,
  pending: PendingSiteRollback,
): PendingSiteRollback {
  const rows = read(db).filter(
    (x) => !(x.siteId === pending.siteId && x.peerUrl === pending.peerUrl),
  );
  rows.push(pending);
  write(db, rows);
  return pending;
}

export function updatePendingSiteRollbackError(
  db: DbDriver,
  siteId: string,
  peerUrl: string,
  error: string,
): PendingSiteRollback | null {
  const rows = read(db);
  const found = rows.find((x) => x.siteId === siteId && x.peerUrl === peerUrl);
  if (!found) return null;
  found.lastError = error;
  write(db, rows);
  return found;
}

export function removePendingSiteRollback(
  db: DbDriver,
  siteId: string,
  peerUrl: string,
): boolean {
  const before = read(db);
  const after = before.filter((x) => !(x.siteId === siteId && x.peerUrl === peerUrl));
  if (after.length === before.length) return false;
  write(db, after);
  return true;
}

/** A successful HTTP-peer sync advances push_cursor to the highest local CRDT
 * sequence included in the request. That cursor is the durable proof that the
 * compensating private write reached the target. */
export function clearCoveredSiteRollbacks(db: DbDriver, peerUrl: string): number {
  const peer = db
    .query("SELECT push_cursor,last_status FROM peers WHERE url = ?")
    .get(peerUrl) as { push_cursor: number; last_status: string | null } | null;
  if (!peer || peer.last_status !== "ok") return 0;
  const before = read(db);
  const after = before.filter(
    (x) => x.peerUrl !== peerUrl || x.requiredSeq > peer.push_cursor,
  );
  write(db, after);
  return before.length - after.length;
}

export function latestLocalSeq(db: DbDriver): number {
  const row = db.query("SELECT MAX(seq) AS seq FROM crdt_changes").get() as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

function readStates(db: DbDriver): SitePublishState[] {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(STATE_META_KEY) as
    | { value: string }
    | null;
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SitePublishState =>
        !!x &&
        typeof x.siteId === "string" &&
        typeof x.targetBase === "string" &&
        typeof x.url === "string" &&
        (x.status === "ready" || x.status === "syncing") &&
        Number.isFinite(x.updatedAt),
    );
  } catch {
    return [];
  }
}

function writeStates(db: DbDriver, states: SitePublishState[]): void {
  if (states.length === 0) {
    db.query("DELETE FROM meta WHERE key = ?").run(STATE_META_KEY);
    return;
  }
  db.query(
    "INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(STATE_META_KEY, JSON.stringify(states));
}

export function listSitePublishStates(db: DbDriver): SitePublishState[] {
  return readStates(db);
}

export function putSitePublishState(
  db: DbDriver,
  state: SitePublishState,
): SitePublishState {
  const states = readStates(db).filter(
    (x) => !(x.siteId === state.siteId && x.targetBase === state.targetBase),
  );
  states.push(state);
  writeStates(db, states);
  return state;
}

export function removeSitePublishStates(db: DbDriver, siteId: string): number {
  const before = readStates(db);
  const after = before.filter((x) => x.siteId !== siteId);
  writeStates(db, after);
  return before.length - after.length;
}
