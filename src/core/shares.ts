// Public capability links to a doc / database / site. The `shares` table is
// node-local (declared in schema.ts, deliberately absent from crdt.ts's DOMAIN)
// so it never enters the oplog and never syncs — same trust model as peers.
//
// A share is served either by this node's token-exempt /share/<slug> endpoint
// (transport 'server') or as a presigned static export in a bucket (transport
// 's3'; always read-only — a presigned object can't accept writes). Passwords:
// the server path stores a PBKDF2 verifier (pw_hash+pw_salt); the s3 path is
// end-to-end encrypted, so only pw_salt is kept (it travels in the link) and the
// viewer derives the content key from password+salt — there is no server-side
// verifier on the s3 path.

import type { DbDriver } from "./driver.ts";
import { MhError } from "./errors.ts";
import { randomSuffix } from "./ids.ts";
import { toB64, fromB64 } from "./sync/e2ee.ts";

export type ShareKind = "doc" | "database" | "site";
export type SharePermission = "view" | "edit";
export type ShareTransport = "server" | "s3";

const SHARE_KINDS: ReadonlySet<string> = new Set<ShareKind>(["doc", "database", "site"]);

export interface ShareRow {
  slug: string;
  kind: ShareKind;
  target_id: string;
  permission: SharePermission;
  transport: ShareTransport;
  /** base64 salt; null = no password. */
  pw_salt: string | null;
  /** base64 PBKDF2 verifier — server path only (s3 password is client-side E2EE). */
  pw_hash: string | null;
  /** epoch ms; null = never. */
  expires_at: number | null;
  /** synthetic node id every edit through this share is attributed to (edit only). */
  guest_node_id: string | null;
  /** Reachable base URL chosen at creation (for the link / source label). */
  served_base: string | null;
  // Vestigial s3_* columns (object-storage shares now live in the bucket, not in
  // this table); kept so the SELECT list matches existing DBs. Always null here.
  s3_peer_url: string | null;
  s3_object_prefix: string | null;
  s3_presign_exp: number | null;
  s3_key_b64: string | null;
  created_at: number;
}

const SHARE_COLS =
  "slug, kind, target_id, permission, transport, pw_salt, pw_hash, expires_at, guest_node_id, served_base, s3_peer_url, s3_object_prefix, s3_presign_exp, s3_key_b64, created_at";

export interface CreateShareInput {
  kind: ShareKind;
  target_id: string;
  permission?: SharePermission;
  /** base64 salt + verifier (server path); produce with hashSharePassword. */
  pwSalt?: string | null;
  pwHash?: string | null;
  expiresAt?: number | null;
  /** Reachable base URL recorded for the link / source label. */
  servedBase?: string | null;
}

/**
 * Mint a server-transport share row. (Object-storage shares are NOT stored here —
 * they live in the bucket; see sync/share-export.ts.) Validates enums + the
 * `edit ⇒ server` rule and allocates an unguessable slug (+ guest node for edit).
 * The caller verifies that `target_id` exists.
 */
export function createShare(db: DbDriver, input: CreateShareInput): ShareRow {
  const permission = input.permission ?? "view";
  if (!SHARE_KINDS.has(input.kind))
    throw new MhError("invalid_input", `unknown share kind: ${input.kind}`);
  if (permission !== "view" && permission !== "edit")
    throw new MhError("invalid_input", `unknown share permission: ${permission}`);

  let slug = randomSuffix(12);
  while (getShare(db, slug)) slug = randomSuffix(12);
  const guest = permission === "edit" ? "g" + randomSuffix(8) : null;

  db.query(
    `INSERT INTO shares (${SHARE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slug,
    input.kind,
    input.target_id,
    permission,
    "server",
    input.pwSalt ?? null,
    input.pwHash ?? null,
    input.expiresAt ?? null,
    guest,
    input.servedBase ?? null,
    null,
    null,
    null,
    null,
    Date.now(),
  );
  return getShare(db, slug)!;
}

export function getShare(db: DbDriver, slug: string): ShareRow | null {
  return (
    (db.query(`SELECT ${SHARE_COLS} FROM shares WHERE slug = ?`).get(slug) as ShareRow | null) ??
    null
  );
}

export function listShares(db: DbDriver): ShareRow[] {
  return db
    .query(`SELECT ${SHARE_COLS} FROM shares ORDER BY created_at DESC`)
    .all() as ShareRow[];
}

/** Shares pointing at one target — used to surface existing links in the UI. */
export function listSharesForTarget(db: DbDriver, targetId: string): ShareRow[] {
  return db
    .query(`SELECT ${SHARE_COLS} FROM shares WHERE target_id = ? ORDER BY created_at DESC`)
    .all(targetId) as ShareRow[];
}

export function deleteShare(db: DbDriver, slug: string): boolean {
  return db.query("DELETE FROM shares WHERE slug = ?").run(slug).changes > 0;
}

/** True once a share is past its expiry (null expiry = never expires). */
export function shareExpired(row: ShareRow, now = Date.now()): boolean {
  return row.expires_at != null && now >= row.expires_at;
}

// ---- password (PBKDF2-SHA256, matching e2ee.ts's KDF parameters) ---------------

const PW_ITER = 600_000;
const PW_SALT_BYTES = 16;
const PW_HASH_BITS = 256;

// WebCrypto wants a real ArrayBuffer; mirror e2ee.ts's `ab` to avoid TS widening.
function ab(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    ab(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: ab(salt), iterations: PW_ITER, hash: "SHA-256" },
    base,
    PW_HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Derive a fresh {salt, hash} verifier for the server-path password. */
export async function hashSharePassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(PW_SALT_BYTES));
  const hash = await pbkdf2(password, salt);
  return { salt: toB64(salt), hash: toB64(hash) };
}

/** Constant-time check of `password` against a share's stored verifier. A share
 *  with no password always returns true (nothing to verify). */
export async function verifySharePassword(row: ShareRow, password: string): Promise<boolean> {
  if (!row.pw_hash || !row.pw_salt) return true;
  const expect = fromB64(row.pw_hash);
  const got = await pbkdf2(password, fromB64(row.pw_salt));
  return timingSafeEqual(expect, got);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
