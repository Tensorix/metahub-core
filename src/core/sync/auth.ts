// Token gate for the server. In --debug mode auth is disabled entirely. Otherwise
// a single token guards every request. A token may arrive three ways so both
// programmatic clients and browsers work:
//   - Authorization: Bearer <token>   (API clients, and the injected fetch shim)
//   - Cookie: mh_token=<token>          (browser top-level navigations)
//   - ?token=<token>                    (links / quick curl testing)
// Browsers without a token get an unlock page that stores the password to
// localStorage + a cookie and reloads; served HTML then gets a fetch shim that
// re-attaches the token as a Bearer header on same-origin API calls.

import type { Database } from "bun:sqlite";
import { loadOrRotate } from "./token.ts";
import { isAcceptedGrant } from "./pairing.ts";
import { RENEW_PATH } from "./protocol.ts";

// Three modes:
//   debug        — auth off entirely.
//   staticToken  — fixed token from --token/env; not persisted, never expires.
//   db (managed) — persistent, rotating token in ~/.metahub (see ./token.ts).
export interface AuthConfig {
  debug: boolean;
  staticToken: string | null;
  db: Database | null;
  ttlMs: number;
  graceMs: number;
}

const COOKIE = "mh_token";
/** Shared cookie attributes for the token cookie (server Set-Cookie and the
 *  unlock page's client-side write must stay identical). */
const COOKIE_ATTRS = "path=/; SameSite=Strict; Max-Age=31536000";

/** The `Set-Cookie` value that persists `token` as the browser's mh_token. */
function tokenCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; ${COOKIE_ATTRS}`;
}

/**
 * When a request authenticated via a `?token=` query param and carries no cookie
 * yet, return the `Set-Cookie` to persist it; otherwise null. A `/?token=...`
 * link (QR / "copy login link") authorizes only that one navigation — without
 * this, the browser's follow-up /webui.css, /webui.js etc. carry no credential
 * and 401, serving a broken page. Setting the cookie on the HTML response lets
 * those same-origin sub-requests ride it automatically.
 */
export function queryTokenCookie(req: Request, url: URL, cfg: AuthConfig): string | null {
  const cur = activeToken(cfg);
  if (!cur) return null; // auth off — nothing to persist
  if (cookieToken(req) != null) return null; // already has a cookie session
  const q = url.searchParams.get("token");
  return q && q === cur.token ? tokenCookie(cur.token) : null;
}

function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function extractToken(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return cookieToken(req) ?? url.searchParams.get("token");
}

/** Whether auth is on at all (so the gate runs and the fetch shim is injected). */
export function authActive(cfg: AuthConfig): boolean {
  return !cfg.debug && (cfg.staticToken != null || cfg.db != null);
}

/** The currently-valid token and its expiry, or null when auth is off. */
export function activeToken(cfg: AuthConfig): { token: string; exp: number } | null {
  if (cfg.debug) return null;
  if (cfg.staticToken != null) return { token: cfg.staticToken, exp: Infinity };
  if (cfg.db) {
    const s = loadOrRotate(cfg.db, cfg.ttlMs, cfg.graceMs);
    return { token: s.token, exp: s.exp };
  }
  return null;
}

export function hasValidToken(req: Request, url: URL, cfg: AuthConfig): boolean {
  const cur = activeToken(cfg);
  if (!cur) return true;
  return extractToken(req, url) === cur.token;
}

/**
 * Gate for /sync: accept the master token OR any durable per-peer grant issued
 * during pairing (see ./pairing.ts). Returns true when auth is off (--debug).
 * `db` is needed to look up grants even in staticToken mode where cfg.db is null.
 */
export function acceptsSyncToken(req: Request, url: URL, cfg: AuthConfig, db: Database): boolean {
  if (!authActive(cfg)) return true;
  const presented = extractToken(req, url);
  if (!presented) return false;
  const cur = activeToken(cfg);
  if (cur && presented === cur.token) return true;
  return isAcceptedGrant(db, presented);
}

/**
 * Token exchange: a holder of the current token (or the in-grace previous token)
 * gets the current token back. Managed mode only — returns null otherwise.
 */
export function renewToken(
  req: Request,
  url: URL,
  cfg: AuthConfig,
): { token: string; exp: number } | null {
  if (cfg.debug || cfg.staticToken != null || !cfg.db) return null;
  const s = loadOrRotate(cfg.db, cfg.ttlMs, cfg.graceMs);
  const presented = extractToken(req, url);
  if (!presented) return null;
  if (presented === s.token) return { token: s.token, exp: s.exp };
  if (s.prev && presented === s.prev && Date.now() < s.prevExp) {
    return { token: s.token, exp: s.exp };
  }
  return null;
}

/** A browser navigation (so we can answer with an unlock page instead of a 401). */
export function wantsHtml(req: Request): boolean {
  return req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/** Self-contained password prompt: stores token to localStorage + cookie, reloads. */
export function unlockPage(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unlock</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;
    background:#0d1117;color:#e6edf3}
  form{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:28px;width:300px}
  h1{font-size:16px;margin:0 0 14px}
  input{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:inherit;margin-bottom:12px}
  button{width:100%;padding:8px;border:0;border-radius:6px;background:#238636;color:#fff;cursor:pointer}
  .err{color:#f85149;margin:0 0 12px;font-size:13px}
</style></head><body>
<form id="f" style="display:none">
  <h1>🔒 This server requires a token</h1>
  <p class="err" id="e" style="display:none">Token rejected — try again.</p>
  <input id="t" type="password" placeholder="Token" autocomplete="current-password">
  <button type="submit">Unlock</button>
</form>
<script>
  var KEY = "mh_token";
  function save(t) {
    localStorage.setItem(KEY, t);
    document.cookie = "${COOKIE}=" + encodeURIComponent(t) + "; ${COOKIE_ATTRS}";
  }
  function showForm() {
    document.getElementById("f").style.display = "block";
    // A leftover token means an attempt (or silent renewal) failed the gate.
    if (localStorage.getItem(KEY)) document.getElementById("e").style.display = "block";
    document.getElementById("t").focus();
  }
  document.getElementById("f").addEventListener("submit", function (ev) {
    ev.preventDefault();
    save(document.getElementById("t").value);
    location.reload();
  });
  // Seamless renewal for top-level navigation: if we hold a token, try swapping
  // it for the current one before prompting. Covers the case where the token
  // rotated while this browser held the (in-grace) previous one.
  var stored = localStorage.getItem(KEY);
  if (stored) {
    fetch("${RENEW_PATH}", { headers: { authorization: "Bearer " + stored } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.token) { save(d.token); location.reload(); } else { showForm(); } })
      .catch(showForm);
  } else {
    showForm();
  }
</script>
</body></html>`;
}

/**
 * The injected page runtime (built from src/webui/runtime.ts, served at
 * /mh-runtime.js). Carries what the old inline fetch shim did — same-origin
 * Bearer attach + transparent 401 renewal — plus the offline machinery:
 * service-worker registration and the local-replica RPC bridge that lets
 * hosted site pages read/write hub data with no network. Loaded synchronously
 * (classic script, head-first) so fetch is wrapped before page code runs.
 */
const RUNTIME_TAG = `<script src="/mh-runtime.js"></script>`;

/** Insert the runtime into an HTML document (right after <head>, else prepend). */
export function injectShim(html: string): string {
  const i = html.toLowerCase().indexOf("<head>");
  if (i >= 0) return html.slice(0, i + 6) + RUNTIME_TAG + html.slice(i + 6);
  return RUNTIME_TAG + html;
}

/** Inject the page runtime into HTML responses. Unconditional (unlike the old
 *  token-only shim): the offline bridge matters even in --debug mode where
 *  auth is off — the token half simply no-ops without a stored token.
 *
 *  When `req`/`url` are supplied and the navigation authenticated via a `?token=`
 *  query param, persist that token as the mh_token cookie on this HTML response
 *  so the browser's follow-up asset requests (/webui.css, /webui.js) carry it. */
export async function withShim(
  res: Response,
  cfg: AuthConfig,
  req?: Request,
  url?: URL,
): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const html = injectShim(await res.text());
  const headers = new Headers(res.headers);
  if (req && url) {
    const cookie = queryTokenCookie(req, url, cfg);
    if (cookie) headers.append("set-cookie", cookie);
  }
  return new Response(html, { status: res.status, headers });
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export { HTML_HEADERS };
