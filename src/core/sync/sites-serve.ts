import type { DbDriver } from "../driver.ts";
import type { RouteCtx } from "./routes.ts";
import {
  resolveSite,
  getFileMetaForServe,
  decodeFileRow,
  siteCacheControl,
  type SiteRow,
} from "../sites.ts";
import {
  publicSiteChannelOnThisNode,
  sitePublicAccessState,
} from "../site-channel-store.ts";
import { publicGuestNode } from "../grants-core.ts";
import { policyForSite } from "../access-policy.ts";
import { serveGrantedApi, grantedDepsFromPolicy } from "./grants-routes.ts";
import { getDropKnobs } from "./edge-config.ts";
import { safeDecode } from "./http-util.ts";
import { rateLimiter, PUBLIC_READ_LIMIT, PUBLIC_WRITE_LIMIT } from "./rate-limit.ts";
import { escapeHtml } from "./share-render.ts";
import {
  type AuthConfig,
  hasValidToken,
  wantsHtml,
  unlockPage,
  unauthorized,
  withShim,
  HTML_HEADERS,
} from "./auth.ts";

// Serves agent-published sites at /sites/<name>/<path...>. Imported lazily from
// server.ts so it stays off the CLI startup path. Returns null only for paths it
// does not own (so the caller can fall through to 404).
//
// The route is AUTONOMOUS: /sites/ sits on server.ts's token-exempt list and
// this module runs its own channel-aware access decision per site (default-deny):
//   - public site   → served raw with `public, …` cache headers and NO runtime
//                     injection (the master-token runtime must never reach an
//                     anonymous reader; same red line as /share/, server.ts).
//   - anything else → the master token is required. Unauthenticated browsers
//                     get the unlock page, other clients a 401 — IDENTICAL for
//                     "site is private" and "site does not exist", so an
//                     anonymous caller cannot enumerate site names.
//   - authenticated → normal serving, HTML gets the runtime via withShim.
//
// Conditional requests: every served file carries a weak ETag computed from the
// stored register (getFileMetaForServe) plus a Cache-Control tier
// (siteCacheControl). An If-None-Match hit answers 304 BEFORE any content
// decoding — in particular before resolveBlob's worst-case-5s peer/bucket
// fan-out. A miss falls back to the site's own 404.html (status 404) when
// present, else to the built-in 404 page below.

/** Host wiring serveSite can't do itself: the request's client IP (rate-limit
 *  key material) and an in-process forwarder into the main /api route table
 *  (token-holders under /sites/<name>/api/* get the FULL API). */
export interface ServeSiteOpts {
  ip?: string | null;
  forwardApi?: (req: Request) => Promise<Response>;
}

export async function serveSite(
  req: Request,
  ctx: RouteCtx,
  auth: AuthConfig,
  opts: ServeSiteOpts = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  const rest = url.pathname.slice("/sites/".length);
  if (rest === "") return null; // /sites/ with no site name

  const slash = rest.indexOf("/");
  const name = safeDecode(slash === -1 ? rest : rest.slice(0, slash));
  if (name === null) return new Response("bad request", { status: 400 });

  // /sites/<name> → canonical /sites/<name>/ so relative asset URLs resolve.
  // Unconditional (site existence is not consulted), so it leaks nothing. Use
  // the RAW (still-encoded) segment in the Location so a control-char name can't
  // be re-injected into the header.
  if (slash === -1) return Response.redirect(`${url.origin}/sites/${rest}/`, 301);

  const filePath = safeDecode(rest.slice(slash + 1));
  if (filePath === null) return new Response("bad request", { status: 400 });

  let site: SiteRow | null;
  try {
    site = resolveSite(ctx.db, name);
  } catch {
    site = null;
  }
  const publicHere = !!site && sitePublicAccessState(ctx.db, site).serving;
  const publicChannel = site
    ? publicSiteChannelOnThisNode(ctx.db, site.id)
    : null;

  // Reserved data-API namespace: /sites/<name>/api/* never resolves to files.
  //   - a valid token  → in-process rewrite to the FULL main API (the page a
  //     site owner opens keeps every capability it had);
  //   - no token + public site → the grant-scoped guest surface;
  //   - anything else  → uniform 401 (private and nonexistent identical).
  if (filePath === "api" || filePath.startsWith("api/")) {
    if (hasValidToken(req, url, auth)) {
      if (!site) return notFoundResponse("站点不存在", `没有名为 “${escapeHtml(name)}” 的站点。`);
      if (!opts.forwardApi) return new Response("not found", { status: 404 });
      const fwd = new Request(`${url.origin}/${filePath}${url.search}`, req);
      return opts.forwardApi(fwd);
    }
    if (site && publicHere) {
      const siteId = site.id;
      const key = `${opts.ip ?? "?"}:${siteId}`;
      // One policy → one deps builder → serveGrantedApi. The write gate
      // (--password/--turnstile) is synthesized from the policy's writeGate by
      // grantedDepsFromPolicy, so this realtime write path and the write-inbox
      // enforce the SAME gate (a page not sending x-drop-pass/x-turnstile-token
      // gets 401 here; the SDK supplies those proofs on the live request).
      const policy = policyForSite({
        // Once a v2 channel exists its policy snapshot is authoritative. Null
        // or malformed channel policy is default-deny; falling back to the
        // legacy global grants register would silently widen access.
        publicGrants: publicChannel
          ? publicChannel.policy_json
          : site.public_grants,
        knobs: getDropKnobs(ctx.db, siteId),
      });
      return serveGrantedApi(
        req,
        filePath.slice("api/".length),
        grantedDepsFromPolicy(policy, {
          db: ctx.db,
          principal: { kind: "public", guestNode: publicGuestNode(siteId, ctx.node) },
          allow: (cls) =>
            cls === "read"
              ? rateLimiter.allow("pub-read", key, PUBLIC_READ_LIMIT)
              : rateLimiter.allow("pub-write", key, PUBLIC_WRITE_LIMIT),
          req,
          ip: opts.ip ?? null,
        }),
      );
    }
    return unauthorized();
  }

  // Public site: token-free, shared-cacheable, and NEVER runtime-injected —
  // the page an anonymous visitor sees is byte-identical to the owner's view.
  if (site && publicHere) {
    return serveSiteFile(req, ctx.db, site.id, filePath, { spa: site.spa === 1, isPublic: true });
  }

  // Private or nonexistent: authenticate first, and answer the two cases
  // identically to an unauthenticated caller (anti-enumeration). hasValidToken
  // is true when auth is off (--debug / desktop sidecar), keeping local
  // preview untouched.
  if (!hasValidToken(req, url, auth)) {
    return wantsHtml(req)
      ? // x-mh-unlock: the service worker must not cache this 200 as the shell.
        new Response(unlockPage(), { headers: { ...HTML_HEADERS, "x-mh-unlock": "1" } })
      : unauthorized();
  }

  if (!site) return notFoundResponse("站点不存在", `没有名为 “${escapeHtml(name)}” 的站点。`);
  const res = await serveSiteFile(req, ctx.db, site.id, filePath, { spa: site.spa === 1 });
  return withShim(res, auth, req, url);
}

/**
 * Serve one file of a resolved site: ETag/304 negotiation → decode → response
 * with content-type + cache headers. Shared by /sites/<name>/ (above) and the
 * token-exempt /share/<slug>/ site path (share-serve.ts) so both surfaces agree
 * on caching and 404 behavior. This function never injects the runtime — the
 * /sites/ caller adds it (withShim) only on the authenticated private branch.
 * `isPublic` selects the Cache-Control scope: only a visibility:public site may
 * pass true (share responses stay `private` always — the slug IS the
 * capability and must never enter a shared cache).
 */
export async function serveSiteFile(
  req: Request,
  db: DbDriver,
  siteId: string,
  path: string,
  opts: { spa?: boolean; isPublic?: boolean } = {},
): Promise<Response> {
  const meta = getFileMetaForServe(db, siteId, path, { spa: opts.spa });
  if (!meta) return notFoundResponse("页面不存在", "这个站点里没有这个页面或文件。");

  const cacheControl = siteCacheControl(meta.row.content_type, meta.row.encoding, opts.isPublic ?? false);
  const headers: Record<string, string> = { etag: meta.etag, "cache-control": cacheControl };

  // If-None-Match hit → 304 with no body (and no blob resolution).
  if (etagMatches(req.headers.get("if-none-match"), meta.etag)) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = await decodeFileRow(db, meta.row);
  if (!bytes) {
    // Row exists but its bytes are unreachable (blob evicted locally and no
    // peer/bucket answered in time) — a real miss for this request.
    return notFoundResponse("资源暂不可用", "文件的内容暂时无法取得，请稍后重试。");
  }
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, {
    status: meta.status, // 404 when serving the site's own 404.html
    headers: {
      ...headers,
      "content-type": meta.row.content_type,
      // Site pages share the WebUI origin: URLs (paths, ?token= on owner
      // navigations) must never leak off-origin via Referer.
      "referrer-policy": "same-origin",
    },
  });
}

/** Weak ETag comparison against an If-None-Match header (which may carry a
 *  comma-separated list, or `*`). Weak: the `W/` prefix is ignored on both
 *  sides — byte-identity of the opaque tag is what we mean by "unchanged". */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => (t.startsWith("W/") ? t.slice(2) : t);
  const target = opaque(etag);
  for (const part of header.split(",")) {
    const t = part.trim();
    if (t === "*" || opaque(t) === target) return true;
  }
  return false;
}

// ---- built-in 404 page ---------------------------------------------------------

/** Small self-contained 404 page, visually aligned with share-serve's pageShell
 *  (same palette tokens + dark scheme). `no-store`: a negative answer must not
 *  stick in any cache — the site may be created/republished a second later. */
function notFoundResponse(title: string, detail: string): Response {
  const html = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root{--bg:#ffffff;--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--accent:#0969da;--card:#f6f8fa}
  @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#4493f8;--card:#161b22}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
  main{max-width:420px;text-align:center}
  .code{font-size:56px;font-weight:700;letter-spacing:2px;color:var(--muted);margin:0 0 6px;font-variant-numeric:tabular-nums}
  h1{font-size:20px;margin:0 0 10px}
  p{color:var(--muted);font-size:14px;margin:0 0 22px}
  a.home{display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--accent);
    text-decoration:none;border-radius:8px;padding:8px 18px;font-size:14px}
  footer{margin-top:34px;color:var(--muted);font-size:12px}
</style></head><body><main>
<p class="code">404</p>
<h1>${escapeHtml(title)}</h1>
<p>${detail}</p>
<a class="home" href="./">返回站点首页</a>
<footer>由 metahub 托管</footer>
</main></body></html>`;
  return new Response(html, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
