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
    document.cookie = "${COOKIE}=" + encodeURIComponent(t) + "; path=/; SameSite=Strict; Max-Age=31536000";
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
 * Wrap window.fetch so same-origin requests carry the stored token as a Bearer
 * header, and so a 401 transparently swaps an old token for the current one
 * (via ${RENEW_PATH}) and retries once — seamless renewal after a rotation.
 */
const SHIM = `<script>(function(){
  var KEY = "mh_token";
  function save(t){
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.cookie = KEY + "=" + encodeURIComponent(t) + "; path=/; SameSite=Strict; Max-Age=31536000";
  }
  var orig = window.fetch.bind(window);
  window.fetch = function(input, init){
    init = init || {};
    var t = null; try { t = localStorage.getItem(KEY); } catch (e) {}
    var url;
    try { url = new URL((typeof input === "string" ? input : input.url), location.href); } catch (e) { url = null; }
    var same = url && url.origin === location.origin;
    if (same && t) {
      var h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
      if (!h.has("authorization")) h.set("authorization", "Bearer " + t);
      init.headers = h;
    }
    return orig(input, init).then(function(res){
      if (res.status !== 401 || !same || !t || init.__mhRetried) return res;
      return orig("${RENEW_PATH}", { headers: { authorization: "Bearer " + t } }).then(function(r){
        if (!r.ok) return res;
        return r.json().then(function(d){
          if (!d || !d.token) return res;
          save(d.token);
          var h2 = new Headers(init.headers || {});
          h2.set("authorization", "Bearer " + d.token);
          init.headers = h2;
          init.__mhRetried = true;
          return orig(input, init);
        });
      }).catch(function(){ return res; });
    });
  };
})();</script>`;

/** Insert the fetch shim into an HTML document (right after <head>, else prepend). */
export function injectShim(html: string): string {
  const i = html.toLowerCase().indexOf("<head>");
  if (i >= 0) return html.slice(0, i + 6) + SHIM + html.slice(i + 6);
  return SHIM + html;
}

/** For HTML responses when auth is active, inject the shim; otherwise pass through. */
export async function withShim(res: Response, cfg: AuthConfig): Promise<Response> {
  if (!authActive(cfg)) return res;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const html = injectShim(await res.text());
  const headers = new Headers(res.headers);
  return new Response(html, { status: res.status, headers });
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export { HTML_HEADERS };
