// Managed server auth token, persisted in the `meta` table (same pattern as
// getNodeId in ../node.ts). The DB is the source of truth: the running server
// reads state per request, so a separate `mh token refresh` process is picked up
// immediately and expiry rotation happens lazily on the next request.
//
//   auth_token          current token
//   auth_token_exp      when it expires (epoch ms) → lazy rotation past this
//   auth_token_prev     the token from before the last rotation (one generation)
//   auth_token_prev_exp until when `prev` may still be exchanged (epoch ms)

import type { Database } from "bun:sqlite";
import { randomSuffix } from "../ids.ts";

const K_TOKEN = "auth_token";
const K_EXP = "auth_token_exp";
const K_PREV = "auth_token_prev";
const K_PREV_EXP = "auth_token_prev_exp";

export interface TokenState {
  token: string;
  /** Epoch ms; once `now > exp`, the next request rotates. */
  exp: number;
  /** The immediately-previous token, exchangeable until `prevExp`. */
  prev: string | null;
  /** Epoch ms; how long `prev` stays exchangeable. */
  prevExp: number;
}

/** Parse a duration like "30d" / "24h" / "90m" / "3600" (bare number = seconds). */
export function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n * 1000; // "s" or bare = seconds
  }
}

const DAY = 86_400_000;
/** Default token lifetime (override with METAHUB_TOKEN_TTL). */
export const DEFAULT_TTL_MS = parseDuration(process.env.METAHUB_TOKEN_TTL, 30 * DAY);
/** Default grace window an old token stays swappable (override with METAHUB_TOKEN_GRACE). */
export const DEFAULT_GRACE_MS = parseDuration(process.env.METAHUB_TOKEN_GRACE, 7 * DAY);

function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Current persisted state, or null if no token has been minted yet. */
export function readState(db: Database): TokenState | null {
  const token = getMeta(db, K_TOKEN);
  if (!token) return null;
  const prev = getMeta(db, K_PREV);
  return {
    token,
    exp: Number(getMeta(db, K_EXP) ?? 0),
    prev: prev && prev.length > 0 ? prev : null,
    prevExp: Number(getMeta(db, K_PREV_EXP) ?? 0),
  };
}

/** Rotate: current → prev (swappable for `graceMs`), mint a fresh current. */
export function rotate(db: Database, ttlMs: number, graceMs: number): TokenState {
  const now = Date.now();
  const old = getMeta(db, K_TOKEN);
  const next: TokenState = {
    token: randomSuffix(24),
    exp: now + ttlMs,
    prev: old,
    prevExp: old ? now + graceMs : 0,
  };
  setMeta(db, K_TOKEN, next.token);
  setMeta(db, K_EXP, String(next.exp));
  setMeta(db, K_PREV, next.prev ?? "");
  setMeta(db, K_PREV_EXP, String(next.prevExp));
  return next;
}

/** Persisted state, minting or rotating when missing/expired. */
export function loadOrRotate(db: Database, ttlMs: number, graceMs: number): TokenState {
  const s = readState(db);
  if (!s || Date.now() > s.exp) return rotate(db, ttlMs, graceMs);
  return s;
}
