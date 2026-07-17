// The room's HTTP surface (/r/<slug>/*) — PORTABLE, driver-only, pure
// (Request → Response) over injected host deps, so the exact same handler runs
// inside the MhRoom Durable Object (src/workers/room.ts over DoSqlDriver) and
// under Bun for the in-process e2e suite (room-host.test.ts over bun:sqlite).
//
// Two faces:
//   owner (Bearer ownerSecret, constant-time — independent of the master
//   token, design.md §7 red line 4):
//     POST owner/provision      initRoomDb (idempotent) + expiry alarm
//     POST owner/sync           handleOwnerSync (protocol mismatch → 409)
//     POST owner/blob/<hash>    chunked site-file blob upload (≤1MiB/chunk)
//     POST owner/destroy        physical teardown (host deletes storage)
//   guest (per-share access control; an unprovisioned room answers a uniform
//   404 to EVERYTHING guest-side — anti-enumeration):
//     POST unlock               password → per-visitor session cookie
//     GET  <path>               the shared site, served from the partition
//     *    api/*                the grant-scoped data surface (grants-routes)
//     GET  ws                   WebSocket upgrade — handled by the HOST shell
//                               (runtime-specific accept); session helpers and
//                               the message handler live here.
//
// The room holds ZERO outbound credentials and never calls out (§7 red line 4);
// everything below only reads/writes its own database and answers requests.

import type { DbDriver } from "../driver.ts";
import { errorCode, type MhErrorCode } from "../errors.ts";
import { randomSuffix } from "../ids.ts";
import { parseGrantSet } from "../grants-core.ts";
import { serveGrantedApi } from "./grants-routes.ts";
import { rateLimiter, SHARE_LIMIT } from "./rate-limit.ts";
import { resolveSiteFileRow, base64ToBytes } from "../sites-core.ts";
import { verifyPasswordVerifier } from "../shares.ts";
import {
  readGuestSession,
  mintGuestSession,
  timingSafeStr,
  type GuestSessionScope,
} from "./guest-session.ts";
import {
  handleGuestWrite,
  handleOwnerSync,
  initRoomDb,
  mintRoomGuestSub,
  readRoomConfig,
  roomBlobBytes,
  roomExpired,
  roomPutBlobChunk,
  ROOM_BLOB_CHUNK_LIMIT,
  type OwnerSyncRequest,
  type RoomConfig,
} from "./room-protocol.ts";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const HASH_RE = /^[0-9a-f]{16,64}$/;
const ROOM_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface RoomHostDeps {
  db: DbDriver;
  /** The edge owner secret ("drt_…"); empty/undefined denies every owner route. */
  ownerToken: string | undefined;
  /** Broadcast a data-changed poke to connected guests (WS fan-out). */
  poke?: (seq: number) => void;
  /** Physical destruction — DO: deleteAll + close sockets; tests: drop the db. */
  destroy: () => void | Promise<void>;
  /** Schedule (epoch ms) / clear (null) the expiry self-destruct alarm. */
  setAlarm?: (at: number | null) => void | Promise<void>;
  /** Cede CPU so a frozen workerd clock can advance (HLC counter headroom —
   *  DO shell passes scheduler.wait(1)). Optional belt-and-braces: hlc.ts's
   *  carry-into-millis already keeps overflow correct without it. */
  yieldClock?: () => Promise<void>;
}

// ---- small helpers -------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

const STATUS: Partial<Record<MhErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  rate_limited: 429,
};

function errJson(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  return json(code ? { error: message, code } : { error: message }, code ? (STATUS[code] ?? 400) : 400);
}

function plain404(): Response {
  return new Response("not found", { status: 404 });
}

function wantsHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

function isOwner(req: Request, ownerToken: string | undefined): boolean {
  if (!ownerToken) return false;
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") && timingSafeStr(h.slice(7), ownerToken);
}

function tryConfig(db: DbDriver): RoomConfig | null {
  try {
    return readRoomConfig(db);
  } catch {
    return null;
  }
}

function maxSeq(db: DbDriver): number {
  try {
    const row = db.query("SELECT MAX(seq) AS m FROM crdt_changes").get() as { m: number | null };
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

/** Let the host cede CPU when the room's persisted HLC counter nears the hex4
 *  ceiling — under workerd's frozen request clock a hot room could otherwise
 *  burn through the counter within one millisecond. Correctness never depends
 *  on this (carryCounter in hlc.ts carries overflow into millis); this only
 *  keeps timestamps dense. */
async function hlcHeadroom(db: DbDriver, deps: RoomHostDeps): Promise<void> {
  if (!deps.yieldClock) return;
  const row = db.query("SELECT value FROM meta WHERE key = 'hlc'").get() as
    | { value: string }
    | null;
  if (!row) return;
  // `<millis:15>-<hex4>-<node>` — the counter is chars 16..20.
  const counter = parseInt(row.value.slice(16, 20), 16);
  if (Number.isFinite(counter) && counter > 0xf000) await deps.yieldClock();
}

// ---- guest sessions (mirrors share-serve via the shared guest-session module) --------

function roomSecret(db: DbDriver): string {
  const read = () =>
    db.query("SELECT value FROM room_config WHERE key = 'cookie_secret'").get() as
      | { value: string }
      | null;
  const row = read();
  if (row) return row.value;
  db.query(
    "INSERT INTO room_config (key, value) VALUES ('cookie_secret', ?) ON CONFLICT(key) DO NOTHING",
  ).run(randomSuffix(32));
  return read()!.value;
}

function roomSessionScope(db: DbDriver, cfg: RoomConfig): GuestSessionScope {
  return { secret: roomSecret(db), cookieName: "mh_room_" + cfg.slug, scopeKey: cfg.slug };
}

function sessionTtl(cfg: RoomConfig): number {
  return cfg.expiresAt == null
    ? ROOM_SESSION_TTL_MS
    : Math.min(ROOM_SESSION_TTL_MS, Math.max(0, cfg.expiresAt - Date.now()));
}

async function readRoomSession(
  db: DbDriver,
  cfg: RoomConfig,
  req: Request,
): Promise<{ exp: number; sub: string } | null> {
  return readGuestSession(roomSessionScope(db, cfg), req.headers.get("cookie"));
}

async function mintRoomSession(
  db: DbDriver,
  cfg: RoomConfig,
  url: URL,
): Promise<{ sub: string; cookie: string }> {
  const minted = await mintGuestSession(roomSessionScope(db, cfg), {
    sub: mintRoomGuestSub(cfg),
    ttlMs: sessionTtl(cfg),
    path: `/r/${cfg.slug}`,
    secure: url.protocol === "https:",
  });
  return { sub: minted.sub, cookie: minted.cookie };
}

function withSetCookie(res: Response, setCookie: string | null): Response {
  if (!setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append("set-cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

/** Session context for a WebSocket upgrade: null = refuse (unprovisioned /
 *  expired / password-locked without a session). A cookieless connection to an
 *  unlocked room gets a fresh per-connection sub (P2 WS writes attribute to it). */
export async function roomWsSession(
  db: DbDriver,
  req: Request,
): Promise<{ cfg: RoomConfig; sub: string } | null> {
  const cfg = tryConfig(db);
  if (!cfg || roomExpired(cfg)) return null;
  const sess = await readRoomSession(db, cfg, req);
  if (cfg.pwHash && !sess) return null;
  return { cfg, sub: sess?.sub || mintRoomGuestSub(cfg) };
}

// ---- WebSocket message handling (P2 write intents) ------------------------------------

export interface RoomWsOutcome {
  /** JSON reply for THIS socket, or null (nothing to say). */
  reply: string | null;
  /** Broadcast a poke to every connected guest. */
  poke: boolean;
  seq: number;
}

/** Handle one guest WS message: `{type:"write", intent, id?}` applies a write
 *  intent through handleGuestWrite (grants + guardrails + room-stamped HLC)
 *  and answers `{type:"result"|"error", id, …}`. Ping/pong is the host's
 *  auto-response pair and never reaches here. */
export async function roomWsMessage(
  db: DbDriver,
  sub: string,
  raw: string,
): Promise<RoomWsOutcome> {
  let msg: { type?: unknown; id?: unknown; intent?: unknown };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return {
      reply: JSON.stringify({ type: "error", error: "malformed message", code: "invalid_input" }),
      poke: false,
      seq: 0,
    };
  }
  const id = msg?.id;
  if (msg?.type !== "write" || typeof msg.intent !== "object" || msg.intent === null) {
    return {
      reply: JSON.stringify({ type: "error", id, error: "unknown message type", code: "invalid_input" }),
      poke: false,
      seq: 0,
    };
  }
  const cfg = tryConfig(db);
  if (!cfg) {
    return {
      reply: JSON.stringify({ type: "error", id, error: "unauthorized", code: "auth" }),
      poke: false,
      seq: 0,
    };
  }
  try {
    const record = db.transaction(() =>
      handleGuestWrite(db, cfg, { sub }, msg.intent as Parameters<typeof handleGuestWrite>[3]),
    )();
    return { reply: JSON.stringify({ type: "result", id, record }), poke: true, seq: maxSeq(db) };
  } catch (e) {
    return {
      reply: JSON.stringify({
        type: "error",
        id,
        error: e instanceof Error ? e.message : String(e),
        code: errorCode(e),
      }),
      poke: false,
      seq: 0,
    };
  }
}

// ---- the fetch handler ----------------------------------------------------------------

export function createRoomFetch(deps: RoomHostDeps): (req: Request) => Promise<Response> {
  const { db } = deps;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return plain404();
    const pathSlug = decodeURIComponent(m[1]!);
    // Canonical /r/<slug>/ so the page's relative asset/api URLs resolve.
    if (m[2] === undefined) {
      return new Response(null, { status: 301, headers: { location: `/r/${m[1]}/` } });
    }
    const sub = decodeURIComponent(m[2]!.slice(1));

    // ---- owner face -------------------------------------------------------------
    if (sub === "owner" || sub.startsWith("owner/")) {
      if (!isOwner(req, deps.ownerToken)) return json({ error: "unauthorized", code: "auth" }, 401);
      if (req.method !== "POST") return json({ error: "not found", code: "not_found" }, 404);

      if (sub === "owner/provision") {
        const body = (await req.json().catch(() => null)) as {
          slug?: unknown;
          guestBase?: unknown;
          grants?: unknown;
          pwHash?: unknown;
          pwSalt?: unknown;
          expiresAt?: unknown;
        } | null;
        if (!body || typeof body.guestBase !== "string" || body.guestBase === "")
          return json({ error: "provision needs a guestBase", code: "invalid_input" }, 400);
        const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
        const cfg = initRoomDb(db, {
          slug: typeof body.slug === "string" && body.slug !== "" ? body.slug : pathSlug,
          guestBase: body.guestBase,
          grants: str(body.grants) ?? "",
          pwHash: str(body.pwHash),
          pwSalt: str(body.pwSalt),
          expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
        });
        await deps.setAlarm?.(cfg.expiresAt ?? null);
        return json({ slug: cfg.slug, room_node: cfg.roomNode, provisioned: true });
      }

      const cfg = tryConfig(db);
      if (!cfg) return json({ error: "room is not provisioned", code: "not_found" }, 404);

      if (sub === "owner/sync") {
        const body = (await req.json().catch(() => null)) as OwnerSyncRequest | null;
        if (!body || typeof body.protocol !== "number" || !Array.isArray(body.changes))
          return json({ error: "malformed sync request", code: "invalid_input" }, 400);
        await hlcHeadroom(db, deps);
        try {
          const resp = handleOwnerSync(db, body, cfg);
          if (resp.share_state === "active" && body.changes.length > 0) deps.poke?.(maxSeq(db));
          return json(resp);
        } catch (e) {
          return errJson(e); // protocol mismatch → MhError("conflict") → 409 upgrade_required
        }
      }

      const blob = /^owner\/blob\/([^/]+)$/.exec(sub);
      if (blob) {
        const hash = blob[1]!.toLowerCase();
        if (!HASH_RE.test(hash)) return json({ error: "bad blob hash", code: "invalid_input" }, 400);
        const idx = Math.floor(Number(url.searchParams.get("idx") ?? 0));
        const total = Math.floor(Number(url.searchParams.get("total") ?? 1));
        if (!Number.isFinite(idx) || !Number.isFinite(total) || idx < 0 || total < 1 || idx >= total || total > 4096)
          return json({ error: "bad chunk indices", code: "invalid_input" }, 400);
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > ROOM_BLOB_CHUNK_LIMIT)
          return json({ error: `chunk must be 1..${ROOM_BLOB_CHUNK_LIMIT} bytes`, code: "invalid_input" }, 400);
        roomPutBlobChunk(db, hash, idx, total, bytes);
        return json({ hash, idx, total, bytes: bytes.byteLength });
      }

      if (sub === "owner/destroy") {
        await deps.setAlarm?.(null);
        await deps.destroy();
        return json({ destroyed: true });
      }
      return json({ error: "not found", code: "not_found" }, 404);
    }

    // ---- guest face -------------------------------------------------------------
    // Unprovisioned/expired rooms answer a uniform 404 to every guest request:
    // "no such room" and "not yours to see" are indistinguishable.
    const cfg = tryConfig(db);
    if (!cfg || roomExpired(cfg)) return plain404();

    if (sub === "unlock" && req.method === "POST") return handleUnlock(db, cfg, req, url);

    // WS upgrades are accepted by the host shell (runtime-specific); reaching
    // the plain handler means the shell didn't take it.
    if (sub === "ws") return new Response("upgrade required", { status: 426 });

    const session = await readRoomSession(db, cfg, req);
    const locked = !!cfg.pwHash && !session;

    if (sub === "api" || sub.startsWith("api/")) {
      if (locked) return json({ error: "unauthorized" }, 401);
      const gs = session?.sub
        ? { sub: session.sub, setCookie: null as string | null }
        : await (async () => {
            const minted = await mintRoomSession(db, cfg, url);
            return { sub: minted.sub, setCookie: minted.cookie };
          })();
      // Cookieless callers key the limiter by IP so fresh per-request subs
      // can't sidestep it (same rule as share-serve).
      const key = gs.setCookie ? (req.headers.get("cf-connecting-ip") ?? "?") : gs.sub;
      const res = await serveGrantedApi(req, sub === "api" ? "" : sub.slice("api/".length), {
        db,
        set: parseGrantSet(cfg.grants),
        principal: { kind: "share", guestNode: gs.sub || cfg.guestBase },
        allow: () => rateLimiter.allow("room-api", `${cfg.slug}:${key}`, SHARE_LIMIT),
      });
      if (req.method !== "GET" && res.ok) deps.poke?.(maxSeq(db));
      return withSetCookie(res, gs.setCookie);
    }

    // Site serving (GET only).
    if (req.method !== "GET") return plain404();
    if (locked) {
      return wantsHtml(req)
        ? new Response(unlockPage(cfg, false), { headers: HTML })
        : json({ error: "unauthorized" }, 401);
    }
    return serveRoomFile(db, cfg, sub);
  };
}

// ---- unlock ---------------------------------------------------------------------------

async function handleUnlock(
  db: DbDriver,
  cfg: RoomConfig,
  req: Request,
  url: URL,
): Promise<Response> {
  let pw = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    pw = String(((await req.json().catch(() => ({}))) as { password?: string }).password ?? "");
  } else {
    const form = await req.formData().catch(() => null);
    pw = form ? String(form.get("password") ?? "") : "";
  }
  const ok =
    !cfg.pwHash || !cfg.pwSalt ? true : await verifyPasswordVerifier(cfg.pwHash, cfg.pwSalt, pw);
  if (!ok) return new Response(unlockPage(cfg, true), { headers: HTML, status: 401 });
  // Unlock mints the per-visitor session (its own guest sub id) — every write
  // of this session is attributed to one distinct author, like share unlock.
  const minted = await mintRoomSession(db, cfg, url);
  return new Response(null, {
    status: 303,
    headers: { location: `/r/${cfg.slug}/`, "set-cookie": minted.cookie },
  });
}

// ---- site file serving ------------------------------------------------------------------

function serveRoomFile(db: DbDriver, cfg: RoomConfig, path: string): Response {
  const site = db
    .query("SELECT id, spa FROM sites WHERE __deleted = 0 ORDER BY created_hlc LIMIT 1")
    .get() as { id: string; spa: number } | null;
  if (!site) return roomMessagePage("站点尚未同步", "分享方设备上线同步后即可访问。", 404);
  const resolved = resolveSiteFileRow(db, site.id, path, { spa: site.spa === 1 });
  if (!resolved) return roomMessagePage("页面不存在", "这个站点里没有这个页面或文件。", 404);
  const { row, status } = resolved;
  const headers: Record<string, string> = {
    "content-type": row.content_type,
    // The slug IS the capability — room responses must never enter a shared cache.
    "cache-control": row.content_type.startsWith("text/html")
      ? "private, no-cache"
      : "private, max-age=300",
  };
  if (row.encoding === "utf8") return new Response(row.content ?? "", { status, headers });
  if (row.encoding === "base64") {
    const bytes = base64ToBytes(row.content ?? "");
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body.buffer, { status, headers });
  }
  // blob: reassemble from the chunk store the owner filled via /owner/blob.
  const bytes = row.content ? roomBlobBytes(db, row.content) : null;
  if (!bytes) return roomMessagePage("资源暂不可用", "文件内容尚未同步到房间，请稍后重试。", 404);
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, { status, headers });
}

// ---- pages -------------------------------------------------------------------------------
// Minimal copies of share-serve's pageShell styling (that module drags the
// whole markdown renderer along — the room only needs these two static pages).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_CSS = `
  :root{--bg:#ffffff;--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--accent:#0969da;--card:#f6f8fa}
  @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#4493f8;--card:#161b22}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
  main{max-width:420px;width:100%}
  form.pw{display:flex;flex-direction:column;gap:12px}
  form.pw input{padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg)}
  form.pw button{padding:9px;border:0;border-radius:7px;background:var(--accent);color:#fff;cursor:pointer}
  .err{color:#f85149;font-size:13px;margin:0}
  .muted{color:var(--muted);font-size:14px}
  h1{font-size:20px;margin:0 0 10px;text-align:center}
  footer{margin-top:34px;color:var(--muted);font-size:12px;text-align:center}`;

function unlockPage(cfg: RoomConfig, error: boolean): string {
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>受保护的分享</title>
<style>${PAGE_CSS}</style></head><body><main>
<form method="post" action="/r/${escapeHtml(cfg.slug)}/unlock" class="pw">
  <h1>🔒 此分享受口令保护</h1>
  ${error ? '<p class="err">口令错误，请重试。</p>' : ""}
  <input type="password" name="password" placeholder="口令" autofocus autocomplete="current-password">
  <button type="submit">解锁</button>
</form>
<footer>通过 metahub 分享</footer>
</main></body></html>`;
}

function roomMessagePage(title: string, detail: string, status: number): Response {
  const html = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
<p class="muted" style="text-align:center">${escapeHtml(detail)}</p>
<footer>由 metahub 托管</footer>
</main></body></html>`;
  return new Response(html, { status, headers: { ...HTML, "cache-control": "no-store" } });
}
