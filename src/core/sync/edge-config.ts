// Edge (write-inbox host) configuration, persisted in the node-local `meta`
// table — same trust model and storage pattern as ServerConfig (core/config.ts)
// and peers.config: machine-local, never enters the oplog, never syncs. The
// command face is `mh edge ...`; no peer row is created (the edge host is not a
// sync peer — devices never read data from it, only mail).

import type { DbDriver } from "../driver.ts";

/** The Cloudflare quadruple `mh edge deploy` writes into. All four name
 *  resources the USER created in their own CF account — mh never creates them
 *  (design.md §7 red line 7), it only uploads content into them. */
export interface CfEdgeTarget {
  accountId: string;
  apiToken: string;
  workerName: string;
  d1Id: string;
}

export interface EdgeConfig {
  /** Base URL of the inbox host (workers.dev URL, or any compatible host). */
  endpoint: string;
  /** Owner secret ("drt_…") — independent of the master token so a leaked
   *  inbox credential can only read/ack ciphertext mail, nothing else. */
  token: string;
  /** Present when the host is a CF worker managed by `mh edge deploy`. */
  cf?: CfEdgeTarget;
  /** EDGE_WORKER_VERSION at last deploy — `mh edge status` alignment check. */
  deployedVersion?: string;
}

const CONFIG_KEY = "edge_config";
const KNOBS_PREFIX = "drop_knobs:";

function getMeta(db: DbDriver, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

function setMeta(db: DbDriver, key: string, value: string | null): void {
  if (value === null) {
    db.query("DELETE FROM meta WHERE key = ?").run(key);
    return;
  }
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getEdgeConfig(db: DbDriver): EdgeConfig | null {
  const raw = getMeta(db, CONFIG_KEY);
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as EdgeConfig;
    if (!cfg || typeof cfg.endpoint !== "string" || typeof cfg.token !== "string") return null;
    return cfg;
  } catch {
    return null;
  }
}

export function setEdgeConfig(db: DbDriver, cfg: EdgeConfig | null): void {
  setMeta(db, CONFIG_KEY, cfg ? JSON.stringify(cfg) : null);
}

/**
 * Per-site anti-abuse knobs, set on `mh site grant … --turnstile/--password`.
 * They gate BOTH guest-write transports of the same grant: the write-inbox
 * (enforced at the edge worker) and the server's realtime granted endpoint
 * (Turnstile verification there is a Stage B TODO — see sites-serve.ts).
 * The password itself is never stored — only a PBKDF2 salt (published in
 * mh-drop.json so the page can derive the verifier) and the verifier (sent to
 * the edge registration for constant-time comparison).
 */
export interface DropKnobs {
  turnstileSitekey?: string;
  /** Turnstile SECRET key — needed by the edge for siteverify; never published. */
  turnstileSecret?: string;
  passwordSalt?: string; // base64
  passwordVerifier?: string; // base64 PBKDF2 output
}

export function getDropKnobs(db: DbDriver, siteId: string): DropKnobs | null {
  const raw = getMeta(db, KNOBS_PREFIX + siteId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DropKnobs;
  } catch {
    return null;
  }
}

export function setDropKnobs(db: DbDriver, siteId: string, knobs: DropKnobs | null): void {
  const empty = !knobs || Object.values(knobs).every((v) => v == null);
  setMeta(db, KNOBS_PREFIX + siteId, empty ? null : JSON.stringify(knobs));
}
