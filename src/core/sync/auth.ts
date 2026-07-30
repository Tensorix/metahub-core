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
import { injectRuntimeTag } from "../inject-runtime.ts";
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

/** The `Set-Cookie` value that persists `token` as the browser's mh_token. Adds
 *  `Secure` over TLS so a cookie carrying the master credential can't leak over an
 *  accidental plaintext same-host request. */
function tokenCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; ${COOKIE_ATTRS}${secure ? "; Secure" : ""}`;
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
  return q && q === cur.token ? tokenCookie(cur.token, url.protocol === "https:") : null;
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

/** An EXPLICITLY presented credential (Bearer header or ?token=) — never the
 *  ambient cookie. State-changing /api requests require this: /sites/ pages
 *  run same-origin, so their fetches ride the owner's mh_token cookie
 *  automatically; requiring an explicit token closes that ambient-authority
 *  write path without touching cookie-only GET sub-resources (img,
 *  EventSource) that cannot carry headers. */
export function explicitToken(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return url.searchParams.get("token");
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

// referrer-policy: same-origin on every HTML surface — with sites and shares
// sharing this origin, a full URL (potentially carrying ?token= or a secret
// /share/<slug> path) must never leak to external destinations via Referer.
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "same-origin",
};

// The metahub cube mark + eye glyphs, copied as literal path data from
// src/webui/icons.tsx (CUBE_OUTER/CUBE_INNER, eye/eyeOff) — the unlock page is
// served *before* the WebUI bundle, inside the token gate, so it can't import
// anything. Keep these in sync with icons.tsx if the mark changes.
const CUBE_SVG =
  '<path d="M21 7.5 12 2 3 7.5v9L12 22l9-5.5z"/><path d="m3 7.5 9 5.5 9-5.5M12 22v-9"/>';
const EYE_SVG = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF_SVG =
  '<path d="M4 4l16 16M9.5 9.5a3 3 0 0 0 4 4M6.5 6.7C4.5 8 3 10 2 12c2 4 6 7 10 7 1.6 0 3-.4 4.4-1.1M9.5 5.2A9.7 9.7 0 0 1 12 5c4 0 8 3 10 7-.6 1.3-1.5 2.5-2.5 3.5"/>';

// Two palettes mirrored *by literal value* from src/webui/styles.css :root and
// :root[data-resolved="dark"] — the page carries no stylesheet, so the tokens
// it themes with are inlined here. Change styles.css → change these too.
const UNLOCK_CSS = `
  :root{color-scheme:light;
    --bg:#ffffff;--surface:#fbfbfa;--surface-2:#f1f1ef;--fg:#2c2c30;--fg-soft:#5b5b62;
    --muted:#75757f;--line:#ebebe8;--line-strong:#dededb;--accent:#4a55d6;--accent-fg:#ffffff;
    --accent-soft:#eef0ff;--danger:#d6473b;--danger-soft:#fdeceb;--code-bg:#f8f8f6}
  :root[data-resolved="dark"]{color-scheme:dark;
    --bg:#1a1a1c;--surface:#202022;--surface-2:#2a2a2d;--fg:#e6e6e9;--fg-soft:#b4b4bb;
    --muted:#8b8b95;--line:#2c2c30;--line-strong:#3a3a40;--accent:#7b86ff;--accent-fg:#14141a;
    --accent-soft:#23243a;--danger:#f87168;--danger-soft:#341e1c;--code-bg:#26262a}
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{font-family:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:var(--fg);background:var(--bg);line-height:1.55;
    display:flex;align-items:center;justify-content:center;min-height:100dvh;
    padding:calc(24px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left));
    -webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;overflow:hidden}
  /* Ambient wash: two faint accent blooms behind the card. */
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background:
      radial-gradient(58vmax 58vmax at 14% -8%,color-mix(in srgb,var(--accent) 13%,transparent),transparent 60%),
      radial-gradient(50vmax 50vmax at 108% 112%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 55%)}
  .card{position:relative;z-index:1;width:100%;max-width:420px;background:var(--surface);
    border:1px solid var(--line);border-radius:18px;padding:32px 26px 26px;
    box-shadow:0 24px 60px rgba(20,20,40,.14),0 4px 14px rgba(20,20,40,.06);
    animation:rise .45s cubic-bezier(.2,.7,.3,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
  .brand{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;
    background:var(--accent-soft);color:var(--accent);margin-bottom:18px}
  .brand svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.6;
    stroke-linecap:round;stroke-linejoin:round}
  .brand path{stroke-dasharray:120;stroke-dashoffset:120;animation:draw .9s .12s ease forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  h1{font-size:21px;font-weight:650;letter-spacing:-.01em;margin:0 0 8px}
  .sub{color:var(--muted);font-size:13.5px;margin:0 0 22px;line-height:1.6}
  .sub code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;font-size:12.5px;
    background:var(--code-bg);border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--fg-soft);
    white-space:nowrap}
  .field{position:relative;display:flex;align-items:center}
  input{width:100%;height:50px;padding:0 48px 0 15px;font-size:16px; /* 16px: never let iOS Safari zoom on focus */
    font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;letter-spacing:.01em;
    color:var(--fg);background:var(--bg);border:1.5px solid var(--line-strong);border-radius:12px;
    outline:none;transition:border-color .15s,box-shadow .15s}
  input::placeholder{font-family:var(--ui,inherit);letter-spacing:normal;color:var(--muted);opacity:.8}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
  .card.bad input{border-color:var(--danger);box-shadow:0 0 0 3px color-mix(in srgb,var(--danger) 20%,transparent)}
  .card.bad .field{animation:shake .34s cubic-bezier(.36,.07,.19,.97)}
  @keyframes shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}
    30%,50%,70%{transform:translateX(-5px)}40%,60%{transform:translateX(5px)}}
  .peek{position:absolute;right:6px;width:40px;height:40px;border:0;background:none;cursor:pointer;
    color:var(--muted);display:flex;align-items:center;justify-content:center;border-radius:9px}
  .peek:hover{color:var(--fg-soft)}
  .peek svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}
  .err{color:var(--danger);font-size:13px;font-weight:500;margin:11px 2px 0;
    display:flex;gap:6px;align-items:center;animation:fade .2s ease both}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  button.go{width:100%;height:48px;margin-top:20px;border:0;border-radius:12px;cursor:pointer;
    background:var(--accent);color:var(--accent-fg);font-size:15px;font-weight:600;font-family:inherit;
    display:flex;align-items:center;justify-content:center;gap:9px;
    transition:filter .15s,transform .05s}
  button.go:hover{filter:brightness(1.06)}
  button.go:active{transform:translateY(1px)}
  button.go:disabled{opacity:.7;cursor:default}
  .spin{width:17px;height:17px;border:2px solid color-mix(in srgb,var(--accent-fg) 45%,transparent);
    border-top-color:var(--accent-fg);border-radius:50%;animation:spin .7s linear infinite}
  /* Full-page loader shown while a silent renewal is in flight. */
  .boot{position:fixed;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;background:var(--bg)}
  .boot svg{width:40px;height:40px;fill:none;stroke:var(--accent);stroke-width:1.4;
    stroke-linecap:round;stroke-linejoin:round;animation:breathe 1.5s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.35;transform:scale(.94)}50%{opacity:1;transform:scale(1)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important}
    .brand path{stroke-dashoffset:0}}
`;

/** Self-contained token gate: themed to match the WebUI (light/dark, metahub
 *  mark), validates the token before entering, and stores it to localStorage +
 *  cookie on success. No stylesheet/bundle — it runs inside the auth gate. */
export function unlockPage(): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<title>验证访问令牌 · metahub</title>
<script>
  // FOUC-guard theme resolution, same key/logic as src/webui/theme.ts.
  try {
    var mt = localStorage.getItem("mh-theme");
    var dark = mt === "dark" || (mt !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.resolved = dark ? "dark" : "light";
    document.head.querySelector('meta[name=theme-color]').setAttribute("content", dark ? "#1a1a1c" : "#ffffff");
  } catch (e) {}
</script>
<style>${UNLOCK_CSS}</style></head><body>
<div class="boot" id="boot"><svg viewBox="0 0 24 24">${CUBE_SVG}</svg></div>
<form class="card" id="f" style="display:none" autocomplete="on">
  <div class="brand"><svg viewBox="0 0 24 24">${CUBE_SVG}</svg></div>
  <h1>输入访问令牌</h1>
  <p class="sub">此服务器已开启访问保护。在已登录设备的「设置 → 设备与授权」获取登录链接或二维码,或在服务器上运行 <code>mh token show</code>。</p>
  <div class="field">
    <input id="t" type="password" placeholder="粘贴访问令牌或登录链接"
      autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
    <button type="button" class="peek" id="peek" aria-label="显示令牌"><svg viewBox="0 0 24 24">${EYE_SVG}</svg></button>
  </div>
  <p class="err" id="e" style="display:none"></p>
  <button type="submit" class="go" id="go">解锁并进入</button>
</form>
<script>
  var KEY = "mh_token";
  var form = document.getElementById("f"), boot = document.getElementById("boot");
  var input = document.getElementById("t"), errEl = document.getElementById("e");
  var goBtn = document.getElementById("go"), peek = document.getElementById("peek");

  function save(t) {
    localStorage.setItem(KEY, t);
    document.cookie = "${COOKIE}=" + encodeURIComponent(t) + "; ${COOKIE_ATTRS}" +
      (location.protocol === "https:" ? "; Secure" : "");
  }
  // Accept a pasted "…/?token=xxx" login link, not just the bare token.
  function normalize(v) {
    v = (v || "").trim();
    var m = /[?&#]token=([^&\\s]+)/.exec(v);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return v;
  }
  function showForm(msg) {
    boot.style.display = "none";
    form.style.display = "block";
    if (msg) { errEl.textContent = msg; errEl.style.display = "flex"; }
    input.focus();
  }
  function fail(msg) {
    goBtn.disabled = false;
    goBtn.innerHTML = "解锁并进入";
    errEl.textContent = msg;
    errEl.style.display = "flex";
    form.classList.remove("bad");
    void form.offsetWidth; // reflow so the shake animation restarts
    form.classList.add("bad");
    input.focus();
    input.select();
  }
  peek.addEventListener("click", function () {
    var pw = input.type === "password";
    input.type = pw ? "text" : "password";
    peek.innerHTML = '<svg viewBox="0 0 24 24">' + (pw ? ${JSON.stringify(EYE_OFF_SVG)} : ${JSON.stringify(EYE_SVG)}) + "</svg>";
    peek.setAttribute("aria-label", pw ? "隐藏令牌" : "显示令牌");
    input.focus();
  });
  input.addEventListener("input", function () {
    if (errEl.style.display !== "none") { errEl.style.display = "none"; form.classList.remove("bad"); }
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var token = normalize(input.value);
    if (!token) { fail("请输入访问令牌。"); return; }
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spin"></span>验证中…';
    var hdr = { headers: { authorization: "Bearer " + token } };
    // Prefer the renewal endpoint (managed mode returns the canonical token,
    // also upgrading a pasted in-grace token). Fall back to a cheap
    // authenticated probe so we can reject a bad token *inline* instead of
    // storing it and reloading into another gate.
    fetch("${RENEW_PATH}", hdr)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.token) { save(d.token); location.reload(); return; }
        return fetch("/api/version", hdr).then(function (r) {
          if (r.status === 401) { fail("令牌无效,请检查后重试。"); return; }
          // 200 (static-token mode) or no UI (404) → trust it and reload.
          save(token); location.reload();
        });
      })
      .catch(function () { save(token); location.reload(); }); // network hiccup → old behavior
  });

  // Silent renewal on load: a held token may just need swapping for the current
  // one (rotation while this browser held the in-grace previous). Show the boot
  // loader meanwhile; drop to the form (with a hint) if it can't be renewed.
  var stored = localStorage.getItem(KEY);
  if (stored) {
    fetch("${RENEW_PATH}", { headers: { authorization: "Bearer " + stored } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.token) { save(d.token); location.reload(); }
        else showForm("登录已过期,请重新输入令牌。");
      })
      .catch(function () { showForm(""); });
  } else {
    showForm("");
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
 * The tag + insertion rule live in core/inject-runtime.ts, shared with the
 * service worker's and offline bootstrap's injectors.
 */
export { injectRuntimeTag as injectShim };

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
  // Body-less responses pass through untouched (a 304 must stay empty and a
  // 301 has nothing to inject) — explicit, even though neither carries an
  // html content-type today.
  if (res.status === 304 || res.status === 301) return res;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const html = injectRuntimeTag(await res.text());
  const headers = new Headers(res.headers);
  headers.set("referrer-policy", "same-origin");
  if (req && url) {
    const cookie = queryTokenCookie(req, url, cfg);
    if (cookie) headers.append("set-cookie", cookie);
  }
  return new Response(html, { status: res.status, headers });
}

/** A `?token=` navigation must not leave the credential in the address bar
 *  (bookmarks, screenshots, same-origin Referer, logs): persist the cookie,
 *  then 302 to the same URL with the token stripped. Only HTML navigations —
 *  API calls carrying ?token= are left alone. Returns null when not applicable. */
export function tokenStripRedirect(req: Request, url: URL, cfg: AuthConfig): Response | null {
  if (!wantsHtml(req)) return null;
  if (!url.searchParams.has("token")) return null;
  if (!hasValidToken(req, url, cfg)) return null; // let the gate answer
  const headers = new Headers();
  const cookie = queryTokenCookie(req, url, cfg);
  if (cookie) headers.append("set-cookie", cookie);
  const clean = new URL(url);
  clean.searchParams.delete("token");
  headers.set("location", clean.toString());
  return new Response(null, { status: 302, headers });
}

/** Cookie ambient authority is READ-ONLY: a state-changing /api request must
 *  present its credential explicitly (Bearer/query). Same-origin site pages
 *  otherwise mutate the workspace on the owner's cookie without ever holding
 *  the token. Returns the 401 to serve, or null to continue. */
export function cookieMutationRejection(
  req: Request,
  url: URL,
  cfg: AuthConfig,
): Response | null {
  if (!authActive(cfg)) return null;
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (!url.pathname.startsWith("/api/")) return null;
  if (explicitToken(req, url) != null) return null; // validity checked by the gate
  return unauthorized();
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export { HTML_HEADERS };
