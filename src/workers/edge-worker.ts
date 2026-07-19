// mh-edge-worker — the unified metahub edge script, deployed by `mh edge deploy`
// to the USER'S OWN Cloudflare Worker + D1 (mh never creates the resources; it
// only uploads content into ones the user named). The inbox half below is
// self-contained; the room half (MhRoom Durable Object, /r/<slug>/*) lives in
// room.ts over the portable core modules — everything still bundles into one
// auditable module with zero node:/bun: imports (build.ts asserts it), and the
// same handler logic runs verbatim inside `bun test`.
//
// Two namespaces, one worker, one deploy command:
//   /v1/inbox/*  →  write-inbox (Stage B; D1-backed, handled below)
//   /r/<slug>/*  →  share rooms (Stage C; routed to env.ROOM.idFromName(slug))
//
// Security posture (design.md §7): the edge only ever sees ciphertext envelopes
// (sealed to the owner's P-256 key). It enforces ENVELOPE-level constraints —
// registration, size, Turnstile, password verifier, capacity — and stores mail
// for the owner's device to pull, decrypt, validate and ingest. All semantic
// validation happens at the owner's isolation layer, never here. Rooms hold
// only explicitly-shared partition plaintext (the consent boundary) and zero
// outbound credentials. The owner authenticates with an independent "drt_"
// secret (constant-time compared), never the master token.

export { MhRoom } from "./room.ts";

import { assertAntiAbuse, timingSafeEq } from "../core/sync/anti-abuse.ts";
import { safeDecode } from "../core/sync/http-util.ts";
import { DROP_ENVELOPE_RETENTION_MS } from "../core/intent-retention.ts";

export const EDGE_WORKER_VERSION = "3";
export const EDGE_WORKER_MARKER = "mh-edge-worker";

export const DROP_DEFAULT_MAX_ENVELOPES = 2000;
export const DROP_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DROP_ENVELOPE_LIMIT_BYTES = 64 * 1024;
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

/** D1 schema, also executed by `mh edge deploy` through the D1 HTTP API (the
 *  worker itself never migrates — deploy owns the schema). Statements are
 *  IF NOT EXISTS so re-deploys are idempotent.
 *
 *  CONTRACT: cf-api.ts `d1Exec` splits this on ';' naively (no SQL parser), so do
 *  NOT add a trigger body or a string literal containing ';' here — it would cut
 *  the statement in half. Keep every statement a single semicolon-free CREATE. */
export const EDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS drops (
  drop_id           TEXT PRIMARY KEY,
  turnstile_sitekey TEXT,
  turnstile_secret  TEXT,
  password_salt     TEXT,
  password_verifier TEXT,
  max_envelopes     INTEGER NOT NULL DEFAULT ${DROP_DEFAULT_MAX_ENVELOPES},
  max_bytes         INTEGER NOT NULL DEFAULT ${DROP_DEFAULT_MAX_BYTES},
  created_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS envelopes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id     TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  body        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (drop_id, envelope_id)
);
CREATE INDEX IF NOT EXISTS idx_envelopes_drop ON envelopes(drop_id, id);
CREATE INDEX IF NOT EXISTS idx_envelopes_drop_created ON envelopes(drop_id, created_at);
`;

// ---- host-injectable dependencies ---------------------------------------------------

/** The narrow SQL surface the handler needs. D1 adapts via d1Sql below; tests
 *  adapt bun:sqlite in-memory — same SQLite dialect, full API surface tested. */
export interface EdgeSql {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface InboxDeps {
  sql: EdgeSql;
  /** The owner secret ("drt_…"); empty/undefined denies every owner route. */
  ownerToken: string | undefined;
  /** Injectable for tests; defaults to the real Turnstile siteverify call. */
  verifyTurnstile?: (secret: string, token: string, ip: string | null) => Promise<boolean>;
  now?: () => number;
}

// ---- small helpers -------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

function isOwner(req: Request, ownerToken: string | undefined): boolean {
  if (!ownerToken) return false;
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") && timingSafeEq(h.slice(7), ownerToken);
}

interface DropRow {
  drop_id: string;
  turnstile_sitekey: string | null;
  turnstile_secret: string | null;
  password_salt: string | null;
  password_verifier: string | null;
  max_envelopes: number;
  max_bytes: number;
}

// ---- the handler ---------------------------------------------------------------------

/** Build the inbox fetch handler over injected deps — a pure function of
 *  (Request → Response), so the identical logic is unit-tested in Bun and
 *  served by workerd. */
export function createInboxFetch(deps: InboxDeps): (req: Request) => Promise<Response> {
  const { sql } = deps;
  const now = deps.now ?? (() => Date.now());

  const getDrop = async (dropId: string): Promise<DropRow | null> => {
    const rows = await sql.all<DropRow>("SELECT * FROM drops WHERE drop_id = ?", [dropId]);
    return rows[0] ?? null;
  };
  const pruneExpired = async (dropId: string, currentTime: number): Promise<void> => {
    await sql.run(
      "DELETE FROM envelopes WHERE drop_id = ? AND created_at < ?",
      [dropId, Math.max(0, currentTime - DROP_ENVELOPE_RETENTION_MS)],
    );
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: EDGE_WORKER_MARKER, version: EDGE_WORKER_VERSION });
    }

    const m = /^\/v1\/inbox\/([^/]+)(?:\/(envelopes|stats))?$/.exec(url.pathname);
    if (!m) return err(404, "not_found", "not found");
    const dropId = safeDecode(m[1]!);
    if (dropId === null) return err(400, "invalid_input", "malformed drop id");
    const sub = m[2] ?? null;

    // ---- public route: envelope submission -----------------------------------------
    if (req.method === "POST" && sub === "envelopes") {
      const drop = await getDrop(dropId);
      if (!drop) return err(404, "not_found", "no such drop");
      const t = now();
      await pruneExpired(dropId, t);

      const text = await req.text();
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > DROP_ENVELOPE_LIMIT_BYTES)
        return err(413, "invalid_input", `envelope too large (max ${DROP_ENVELOPE_LIMIT_BYTES} bytes)`);

      let env: {
        v?: unknown;
        envelope_id?: unknown;
        drop_id?: unknown;
        enc?: unknown;
        sealed?: unknown;
      };
      try {
        env = JSON.parse(text) as typeof env;
      } catch {
        return err(400, "invalid_input", "body must be a JSON envelope");
      }
      if (
        !env ||
        env.v !== 1 ||
        typeof env.envelope_id !== "string" ||
        env.envelope_id === "" ||
        env.envelope_id.length > 64 ||
        typeof env.sealed !== "string" ||
        env.drop_id !== dropId
      )
        return err(400, "invalid_input", "malformed envelope");

      // Anti-abuse gate — the SAME check the server's realtime granted API runs
      // (assertAntiAbuse over the identical siteverify + constant-time verifier
      // compare), so a --turnstile/--password grant can't be honored on one
      // transport and silently skipped on the other. The password itself never
      // travels; the verifier grants nothing but the right to submit.
      try {
        await assertAntiAbuse(
          { turnstileSecret: drop.turnstile_secret, passwordVerifier: drop.password_verifier },
          req,
          { verifyTurnstile: deps.verifyTurnstile, ip: req.headers.get("cf-connecting-ip") },
        );
      } catch (e) {
        return err(401, "auth", (e as Error).message);
      }

      // Capacity + insert in ONE conditional statement — atomic in D1, so two
      // racing submissions can't both squeeze past a full drop.
      const ins = await sql.run(
        `INSERT OR IGNORE INTO envelopes (drop_id, envelope_id, body, bytes, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM envelopes WHERE drop_id = ?) < ?
           AND (SELECT COALESCE(SUM(bytes), 0) FROM envelopes WHERE drop_id = ?) + ? <= ?`,
        [dropId, env.envelope_id, text, bytes, t, dropId, drop.max_envelopes, dropId, bytes, drop.max_bytes],
      );
      if (ins.changes === 0) {
        // Nothing inserted: either a replay of a stored envelope (200 — the
        // sender's retry succeeded the first time) or the drop is full (429).
        const dup = await sql.all("SELECT 1 AS x FROM envelopes WHERE drop_id = ? AND envelope_id = ?", [
          dropId,
          env.envelope_id,
        ]);
        if (dup.length > 0) return json({ envelope_id: env.envelope_id, server_time: t, duplicate: true });
        return err(429, "drop_full", "drop is full — try again later");
      }
      return json({ envelope_id: env.envelope_id, server_time: t });
    }

    // ---- everything else is owner-only ----------------------------------------------
    if (!isOwner(req, deps.ownerToken)) return err(401, "auth", "unauthorized");

    if (sub === null && req.method === "PUT") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const s = (k: string): string | null => (typeof body[k] === "string" && body[k] !== "" ? (body[k] as string) : null);
      const n = (k: string, dflt: number): number =>
        typeof body[k] === "number" && (body[k] as number) > 0 ? Math.floor(body[k] as number) : dflt;
      await sql.run(
        `INSERT INTO drops (drop_id, turnstile_sitekey, turnstile_secret, password_salt, password_verifier, max_envelopes, max_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drop_id) DO UPDATE SET
           turnstile_sitekey = excluded.turnstile_sitekey,
           turnstile_secret  = excluded.turnstile_secret,
           password_salt     = excluded.password_salt,
           password_verifier = excluded.password_verifier,
           max_envelopes     = excluded.max_envelopes,
           max_bytes         = excluded.max_bytes`,
        [
          dropId,
          s("turnstile_sitekey"),
          s("turnstile_secret"),
          s("password_salt"),
          s("password_verifier"),
          n("max_envelopes", DROP_DEFAULT_MAX_ENVELOPES),
          n("max_bytes", DROP_DEFAULT_MAX_BYTES),
          now(),
        ],
      );
      return json({ drop_id: dropId, registered: true });
    }

    if (sub === null && req.method === "DELETE") {
      await sql.run("DELETE FROM envelopes WHERE drop_id = ?", [dropId]);
      const r = await sql.run("DELETE FROM drops WHERE drop_id = ?", [dropId]);
      return json({ drop_id: dropId, deleted: r.changes > 0 });
    }

    if (sub === "envelopes" && req.method === "GET") {
      if (!(await getDrop(dropId))) return err(404, "not_found", "no such drop");
      await pruneExpired(dropId, now());
      const afterId = Math.max(0, Number(url.searchParams.get("after_id") ?? 0) || 0);
      const rawLimit = Number(url.searchParams.get("limit") ?? NaN);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), LIST_LIMIT_MAX))
        : LIST_LIMIT_DEFAULT;
      const rows = await sql.all<{ id: number; body: string }>(
        "SELECT id, body FROM envelopes WHERE drop_id = ? AND id > ? ORDER BY id LIMIT ?",
        [dropId, afterId, limit],
      );
      return json({
        rows: rows.map((r) => {
          let envelope: unknown;
          try {
            envelope = JSON.parse(r.body);
          } catch {
            envelope = null;
          }
          return { id: r.id, envelope };
        }),
      });
    }

    if (sub === "envelopes" && req.method === "DELETE") {
      let ids: unknown;
      try {
        ids = ((await req.json()) as { ids?: unknown })?.ids;
      } catch {
        ids = null;
      }
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "number"))
        return err(400, "invalid_input", "body must be {ids: number[]}");
      if (ids.length === 0) return json({ deleted: 0 });
      const marks = ids.map(() => "?").join(", ");
      const r = await sql.run(`DELETE FROM envelopes WHERE drop_id = ? AND id IN (${marks})`, [
        dropId,
        ...ids,
      ]);
      return json({ deleted: r.changes });
    }

    if (sub === "stats" && req.method === "GET") {
      const drop = await getDrop(dropId);
      if (!drop) return err(404, "not_found", "no such drop");
      await pruneExpired(dropId, now());
      const rows = await sql.all<{ n: number; b: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM envelopes WHERE drop_id = ?",
        [dropId],
      );
      return json({
        drop_id: dropId,
        envelopes: rows[0]?.n ?? 0,
        bytes: rows[0]?.b ?? 0,
        max_envelopes: drop.max_envelopes,
        max_bytes: drop.max_bytes,
      });
    }

    return err(404, "not_found", "not found");
  };
}

// ---- Cloudflare entrypoint -----------------------------------------------------------

/** Minimal D1 typing so this file needs no @cloudflare/workers-types dependency. */
interface D1Like {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all(): Promise<{ results?: Record<string, unknown>[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/** Minimal DO namespace typing (same rationale as D1Like). */
interface RoomNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

interface EdgeEnv {
  DB: D1Like;
  OWNER_TOKEN?: string;
  ROOM?: RoomNamespaceLike;
}

function d1Sql(db: D1Like): EdgeSql {
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const r = await db.prepare(sql).bind(...params).all();
      return (r.results ?? []) as T[];
    },
    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      const r = await db.prepare(sql).bind(...params).run();
      return { changes: r.meta?.changes ?? 0 };
    },
  };
}

export default {
  async fetch(req: Request, env: EdgeEnv): Promise<Response> {
    // Room namespace: one DO per slug — the slug is both the room id and the
    // capability, so idFromName gives stable per-share routing.
    const room = /^\/r\/([^/]+)/.exec(new URL(req.url).pathname);
    if (room && env.ROOM) {
      const slug = safeDecode(room[1]!);
      if (slug === null) return new Response("bad request", { status: 400 });
      const id = env.ROOM.idFromName(slug);
      return env.ROOM.get(id).fetch(req);
    }
    return createInboxFetch({ sql: d1Sql(env.DB), ownerToken: env.OWNER_TOKEN })(req);
  },
};
