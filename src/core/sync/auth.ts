// Token gate for the server. In --debug mode auth is disabled entirely. Otherwise
// a single token guards every request. A token may arrive three ways so both
// programmatic clients and browsers work:
//   - Authorization: Bearer <token>   (API clients, and the injected fetch shim)
//   - Cookie: mh_token=<token>          (browser top-level navigations)
//   - ?token=<token>                    (links / quick curl testing)
// Browsers without a token get an unlock page that stores the password to
// localStorage + a cookie and reloads; served HTML then gets a fetch shim that
// re-attaches the token as a Bearer header on same-origin API calls.

export interface AuthConfig {
  debug: boolean;
  token: string | null;
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

export function hasValidToken(req: Request, url: URL, cfg: AuthConfig): boolean {
  if (cfg.debug || !cfg.token) return true;
  return extractToken(req, url) === cfg.token;
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
<form id="f">
  <h1>🔒 This server requires a token</h1>
  <p class="err" id="e" style="display:none">Token rejected — try again.</p>
  <input id="t" type="password" placeholder="Token" autofocus autocomplete="current-password">
  <button type="submit">Unlock</button>
</form>
<script>
  // A leftover token means the previous attempt failed the gate.
  if (localStorage.getItem("mh_token")) document.getElementById("e").style.display = "block";
  document.getElementById("f").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var t = document.getElementById("t").value;
    localStorage.setItem("mh_token", t);
    document.cookie = "${COOKIE}=" + encodeURIComponent(t) + "; path=/; SameSite=Strict; Max-Age=31536000";
    location.reload();
  });
</script>
</body></html>`;
}

/** Wrap window.fetch so same-origin requests carry the stored token as a Bearer header. */
const SHIM = `<script>(function(){
  var t = localStorage.getItem("mh_token");
  if (!t) return;
  var orig = window.fetch.bind(window);
  window.fetch = function(input, init){
    init = init || {};
    var url;
    try { url = new URL((typeof input === "string" ? input : input.url), location.href); } catch (e) { url = null; }
    if (url && url.origin === location.origin) {
      var h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
      if (!h.has("authorization")) h.set("authorization", "Bearer " + t);
      init.headers = h;
    }
    return orig(input, init);
  };
})();</script>`;

/** Insert the fetch shim into an HTML document (right after <head>, else prepend). */
export function injectShim(html: string): string {
  const i = html.toLowerCase().indexOf("<head>");
  if (i >= 0) return html.slice(0, i + 6) + SHIM + html.slice(i + 6);
  return SHIM + html;
}

/** For HTML responses in non-debug mode, inject the shim; otherwise pass through. */
export async function withShim(res: Response, cfg: AuthConfig): Promise<Response> {
  if (cfg.debug || !cfg.token) return res;
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
