// Public, token-exempt serving of a share (/share/<slug>...). Mounted in
// server.ts BEFORE the route matcher and deliberately NOT wrapped in withShim,
// so a share page never carries the master-token runtime (/mh-runtime.js).
//
// Access control is per-share (slug lookup + expiry + optional password) — NOT
// the master token gate. View shares are server-rendered live each request;
// edit shares (server-only) accept writes attributed to the share's guest node
// id (see core/shares.ts, crdt.ts withNodeId) so they replicate to the owner's
// devices as a distinct author. Object-storage shares never reach here — they're
// a presigned static export served by a separate viewer (see share-export.ts).

import type { RouteCtx } from "./routes.ts";
import { safeDecode } from "./http-util.ts";
import { randomSuffix } from "../ids.ts";
import {
  getShare,
  shareExpired,
  verifySharePassword,
  type ShareRow,
} from "../shares.ts";
import { getDocument, updateDocument, documentVersion } from "../documents.ts";
import { getDatabase } from "../databases.ts";
import { listProperties, type PropertyRow } from "../properties.ts";
import { listRecords, updateRecord, getRecord, recordTitleMap } from "../records.ts";
import { parseGrantSet, grantFor } from "../grants-core.ts";
import { resolveSite, listFiles, getFileRow, putFile, deleteFile } from "../sites.ts";
import { serveSiteFile } from "./sites-serve.ts";
import { resolveBlob, blobContentType } from "../blobs.ts";
import { inferContentType } from "../sites-core.ts";
import { withNodeId } from "../crdt.ts";
import { policyForShare } from "../access-policy.ts";
import { serveGrantedApi, grantedDepsFromPolicy } from "./grants-routes.ts";
import { rateLimiter, SHARE_LIMIT } from "./rate-limit.ts";
import { readGuestSession, mintGuestSession, type GuestSessionScope } from "./guest-session.ts";
import { renderMarkdown, escapeHtml } from "./share-render.ts";

const HTML = { "content-type": "text/html; charset=utf-8" } as const;
const HASH_RE = /^[0-9a-f]{16,64}$/;

function notFound(): Response {
  return new Response("not found", { status: 404 });
}
function gone(): Response {
  return new Response("this share has expired", { status: 410 });
}
function unauthorizedJson(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
function wantsHtml(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/html");
}

export interface ServeShareOpts {
  /** Client IP — rate-limit fallback key for cookieless callers. */
  ip?: string | null;
}

export async function serveShare(
  req: Request,
  ctx: RouteCtx,
  opts: ServeShareOpts = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  const rest0 = url.pathname.slice("/share/".length);
  if (!rest0) return null;
  const slash = rest0.indexOf("/");
  const slug = safeDecode(slash === -1 ? rest0 : rest0.slice(0, slash));
  if (slug === null) return notFound();
  const sub = slash === -1 ? "" : rest0.slice(slash + 1);
  if (!slug) return null;

  const share = getShare(ctx.db, slug);
  if (!share) return notFound();
  if (share.transport !== "server") return notFound(); // s3 shares aren't served here
  // Expired = access refused, share row untouched: the row stays manageable
  // (renewable) per the "expired" status contract; only explicit revoke/delete
  // removes it.
  if (shareExpired(share)) return gone();

  // Password gate (the unlock endpoint authenticates inside itself).
  if (sub === "unlock" && req.method === "POST") return handleUnlock(ctx, req, share, url);
  const locked = !!share.pw_hash && !(await readShareSession(ctx, req, share));
  if (locked) {
    return wantsHtml(req)
      ? new Response(passwordPage(share, false), { headers: HTML })
      : unauthorizedJson();
  }

  // Scoped blob bytes for doc/table images (token-exempt, but only hashes the
  // shared target actually references — never an open blob oracle).
  if (sub.startsWith("blob/")) return serveScopedBlob(ctx, share, sub.slice("blob/".length));

  if (share.kind === "doc") return serveDoc(ctx, req, share, sub);
  if (share.kind === "database") return serveTable(ctx, req, share, sub);
  if (share.kind === "site") return serveSiteShare(ctx, req, share, sub, opts);
  return notFound();
}

// ---- documents ----------------------------------------------------------------

async function serveDoc(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
  sub: string,
): Promise<Response> {
  const doc = getDocument(ctx.db, share.target_id);
  if (!doc) return notFound();

  // Edit write-back: replace the whole body, attributed to this visitor's
  // guest sub id (falling back to the share's base guest node).
  if (sub === "doc" && req.method === "POST") {
    if (share.permission !== "edit") return unauthorizedJson();
    const body = (await req.json().catch(() => ({}))) as { body?: string; ifMatch?: string };
    if (typeof body.body !== "string")
      return Response.json({ error: "body required" }, { status: 400 });
    const gs = await guestSessionFor(ctx, req, share);
    try {
      withNodeId(gs.sub || share.guest_node_id, () =>
        updateDocument(ctx.db, share.target_id, { body: body.body }, { ifMatch: body.ifMatch }),
      );
    } catch (e) {
      return Response.json(
        { error: (e as Error).message },
        { status: (e as { code?: string }).code === "stale" ? 409 : 400 },
      );
    }
    return withSessionCookie(
      Response.json({ version: documentVersion(ctx.db, share.target_id) }),
      gs.setCookie,
    );
  }

  if (sub !== "") return notFound();

  const rendered = renderMarkdown(doc.body ?? "", {
    rewriteBlob: (u) => `/share/${share.slug}/${u.replace(/^\//, "")}`,
    // Title-only resolution: the label leaks about as much as the id's own
    // slug already does; the link itself stays inert (see RenderOpts).
    resolveDocLink: (id) => {
      const target = getDocument(ctx.db, id);
      return target ? { title: target.title || id } : null;
    },
  });
  const version = documentVersion(ctx.db, share.target_id);
  const editable = share.permission === "edit";
  const inner = `<article class="doc">${rendered || '<p class="muted">（空文档）</p>'}</article>`;
  const script = editable ? docEditScript(share.slug, version, doc.body ?? "") : "";
  return new Response(
    pageShell(doc.title || "文档", inner, { editable, editLabel: "编辑文档", script }),
    { headers: HTML },
  );
}

function docEditScript(slug: string, version: string, body: string): string {
  return `
  let editing=false; const ver=${JSON.stringify(version)}; const body0=${JSON.stringify(body)};
  const art=document.querySelector('article.doc');
  const btn=document.getElementById('mh-edit');
  let ta;
  btn.addEventListener('click', async ()=>{
    if(!editing){
      editing=true; btn.textContent='保存';
      ta=document.createElement('textarea'); ta.className='mh-raw'; ta.value=body0;
      art.replaceWith(ta); ta.focus();
    } else {
      btn.disabled=true; btn.textContent='保存中…';
      const res=await fetch('/share/${slug}/doc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:ta.value,ifMatch:ver})});
      if(res.ok){ location.reload(); }
      else { const j=await res.json().catch(()=>({})); alert(j.error||'保存失败'); btn.disabled=false; btn.textContent='保存'; }
    }
  });`;
}

// ---- databases / tables -------------------------------------------------------

// `titles` is supplied only for relation columns the share may resolve (see
// serveTable) — array elements map id → target-record title, id as fallback.
function cellText(prop: PropertyRow, value: unknown, titles?: Map<string, string>): string {
  if (value === null || value === undefined) return "";
  if (prop.type === "checkbox") return value ? "✓" : "";
  if (Array.isArray(value)) return value.map((v) => titles?.get(String(v)) ?? String(v)).join(", ");
  return String(value);
}

function cellHtml(prop: PropertyRow, value: unknown, titles?: Map<string, string>): string {
  if (value === null || value === undefined) return "";
  if (prop.type === "checkbox") return value ? "✓" : "";
  if (prop.type === "url") {
    const s = String(value);
    return `<a href="${escapeHtml(s)}" target="_blank" rel="noreferrer noopener">${escapeHtml(s)}</a>`;
  }
  if (Array.isArray(value))
    return value
      .map((v) => `<span class="tag">${escapeHtml(titles?.get(String(v)) ?? String(v))}</span>`)
      .join(" ");
  return escapeHtml(String(value));
}

/** Cell types a recipient can edit inline (free-text-ish). */
function editableType(t: string): boolean {
  return t === "text" || t === "number" || t === "url" || t === "date";
}

async function serveTable(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
  sub: string,
): Promise<Response> {
  const dbRow = getDatabase(ctx.db, share.target_id);
  if (!dbRow) return notFound();
  const props = listProperties(ctx.db, share.target_id).sort((a, b) => a.position - b.position);

  if (sub === "record" && req.method === "POST") {
    if (share.permission !== "edit") return unauthorizedJson();
    const body = (await req.json().catch(() => ({}))) as { id?: string; propId?: string; value?: unknown };
    if (!body.id || !body.propId)
      return Response.json({ error: "id and propId required" }, { status: 400 });
    // Scope: the record must belong to THIS shared database, and the column to a
    // free-text property of it (no schema edits, no cross-database writes).
    const rec = getRecord(ctx.db, body.id);
    if (!rec || rec.database_id !== share.target_id) return notFound();
    const prop = props.find((p) => p.id === body.propId);
    if (!prop || !editableType(prop.type))
      return Response.json({ error: "not an editable column" }, { status: 400 });
    const gs = await guestSessionFor(ctx, req, share);
    try {
      withNodeId(gs.sub || share.guest_node_id, () =>
        updateRecord(ctx.db, body.id!, { [body.propId!]: body.value ?? null }),
      );
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    return withSessionCookie(Response.json({ ok: true }), gs.setCookie);
  }

  if (sub !== "") return notFound();

  const records = listRecords(ctx.db, share.target_id);

  // Relation cells resolve ids → target-record titles, but ONLY when the
  // viewer could read the target anyway: the shared table itself (self-
  // relation) or a database in this share's grant set. Mirrors the write-side
  // relation policy (grants-core assertRelationAllowed) — titles of an
  // unshared database are content, not decoration. Ungated shares therefore
  // show raw ids for cross-database relations: a safe default, not a bug.
  const grants = parseGrantSet(share.grants);
  const relTitles = new Map<string, Map<string, string>>();
  for (const p of props) {
    const target = p.type === "relation" ? p.config?.database : undefined;
    if (!target || relTitles.has(target)) continue;
    if (target === share.target_id || grantFor(grants, target))
      relTitles.set(target, recordTitleMap(ctx.db, target));
  }
  const titlesFor = (p: PropertyRow) =>
    p.type === "relation" ? relTitles.get(p.config?.database ?? "") : undefined;

  const editable = share.permission === "edit";
  const head = props.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("");
  const rows = records
    .map((r) => {
      const tds = props
        .map((p) => {
          const v = r.cells[p.id];
          if (editable && editableType(p.type)) {
            return `<td contenteditable data-rec="${escapeHtml(r.id)}" data-prop="${escapeHtml(
              p.id,
            )}" data-type="${p.type}">${escapeHtml(cellText(p, v))}</td>`;
          }
          return `<td>${cellHtml(p, v, titlesFor(p))}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  const inner = `<div class="table-wrap"><table class="db"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const script = editable ? tableEditScript(share.slug) : "";
  return new Response(pageShell(dbRow.name || "表格", inner, { script, hint: editable ? "可编辑文本/数字/URL/日期单元格，失焦自动保存" : "" }), {
    headers: HTML,
  });
}

function tableEditScript(slug: string): string {
  return `
  document.querySelectorAll('td[contenteditable]').forEach(td=>{
    let orig=td.textContent;
    td.addEventListener('blur', async ()=>{
      const val=td.textContent;
      if(val===orig) return;
      const type=td.dataset.type;
      let v=val; if(type==='number'){ v = val===''?null:Number(val); if(v!==null && !isFinite(v)){ td.textContent=orig; return; } }
      td.classList.add('saving');
      const res=await fetch('/share/${slug}/record',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:td.dataset.rec,propId:td.dataset.prop,value:v})});
      td.classList.remove('saving');
      if(res.ok){ orig=val; td.classList.add('saved'); setTimeout(()=>td.classList.remove('saved'),600); }
      else { td.textContent=orig; const j=await res.json().catch(()=>({})); alert(j.error||'保存失败'); }
    });
  });`;
}

// ---- sites --------------------------------------------------------------------

async function serveSiteShare(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
  sub: string,
  opts: ServeShareOpts = {},
): Promise<Response> {
  let site: ReturnType<typeof resolveSite>;
  try {
    site = resolveSite(ctx.db, share.target_id);
  } catch {
    return notFound();
  }
  const siteId = site.id;

  // Grant-scoped data API — the second mount of the same guest surface the
  // public /sites/<name>/api/* serves (grants-routes.ts), so one page written
  // against relative `api/…` paths runs under both. The password gate already
  // ran; grants come from the share row (node-local — revoke kills them
  // instantly), and writes are attributed to this visitor's session sub id.
  if (sub === "api" || sub.startsWith("api/")) {
    const gs = await guestSessionFor(ctx, req, share);
    // One combined budget (SHARE_LIMIT/min) per session; cookieless callers
    // key by IP so fresh per-request subs can't sidestep the limiter.
    const key = `${share.slug}:${gs.setCookie ? (opts.ip ?? "?") : gs.sub}`;
    // Same policy seam as the public site mount. The share's session gate (slug
    // + optional password, already run) is the access control, so no writeGate
    // is applied here — policyForShare carries no turnstile and the password was
    // spent at unlock; deps get no beforeWrite.
    const policy = policyForShare(share);
    const res = await serveGrantedApi(
      req,
      sub === "api" ? "" : sub.slice("api/".length),
      grantedDepsFromPolicy(policy, {
        db: ctx.db,
        principal: { kind: "share", guestNode: gs.sub || (share.guest_node_id ?? `gs-${share.slug}`) },
        allow: () => rateLimiter.allow("share-api", key, SHARE_LIMIT),
        req,
        ip: opts.ip ?? null,
      }),
    );
    return withSessionCookie(res, gs.setCookie);
  }

  // Edit surface (reserved underscore paths so they never collide with files).
  if (share.permission === "edit") {
    if (sub === "_files") return new Response(siteFilesPage(ctx, share, siteId), { headers: HTML });
    if (sub === "_file" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string; contentType?: string };
      if (!body.path || typeof body.content !== "string")
        return Response.json({ error: "path and content required" }, { status: 400 });
      const gs = await guestSessionFor(ctx, req, share);
      try {
        await withNodeId(gs.sub || share.guest_node_id, () =>
          putFile(ctx.db, siteId, body.path!, { data: body.content!, contentType: body.contentType }),
        );
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
      return withSessionCookie(Response.json({ ok: true }), gs.setCookie);
    }
    if (sub === "_file/delete" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      if (!body.path) return Response.json({ error: "path required" }, { status: 400 });
      const gs = await guestSessionFor(ctx, req, share);
      withNodeId(gs.sub || share.guest_node_id, () => deleteFile(ctx.db, siteId, body.path!));
      return withSessionCookie(Response.json({ ok: true }), gs.setCookie);
    }
    if (sub === "_raw") {
      // Raw text of one file for the editor (text files only).
      const url = new URL(req.url);
      const p = url.searchParams.get("path") ?? "";
      const row = getFileRow(ctx.db, siteId, p);
      if (!row || row.encoding !== "utf8") return Response.json({ content: null });
      return Response.json({ content: row.content ?? "" });
    }
  }

  // Serve the site itself (live), exactly like /sites/<name>/ but token-exempt:
  // same ETag/304 negotiation, same 404.html + SPA fallbacks. Cache headers stay
  // `private` here always (isPublic never set) — the slug IS the capability, so
  // responses under it must never enter a shared cache.
  return serveSiteFile(req, ctx.db, siteId, sub, { spa: site.spa === 1 });
}

function siteFilesPage(ctx: RouteCtx, share: ShareRow, siteId: string): string {
  const files = listFiles(ctx.db, siteId);
  const list = files
    .map(
      (f) =>
        `<li><button class="file" data-path="${escapeHtml(f.path)}" data-text="${
          f.encoding === "utf8" ? "1" : "0"
        }">${escapeHtml(f.path)}</button> <span class="muted">${escapeHtml(f.content_type)}</span></li>`,
    )
    .join("");
  const inner = `
    <p class="hint">编辑站点文件（文本文件可在线编辑；保存即对所有访问者生效）。</p>
    <ul class="files">${list || '<li class="muted">（暂无文件）</li>'}</ul>
    <div id="editor" hidden>
      <div class="row"><strong id="fpath"></strong> <a id="open" target="_blank" rel="noreferrer">预览 ↗</a></div>
      <textarea class="mh-raw" id="fbody"></textarea>
      <div class="row"><button id="save">保存</button></div>
    </div>`;
  const script = `
    const slug=${JSON.stringify(share.slug)};
    const ed=document.getElementById('editor'), fpath=document.getElementById('fpath'), fbody=document.getElementById('fbody'), open=document.getElementById('open');
    let cur=null;
    document.querySelectorAll('button.file').forEach(b=>b.addEventListener('click', async ()=>{
      cur=b.dataset.path; fpath.textContent=cur; open.href='/share/'+slug+'/'+cur;
      if(b.dataset.text==='1'){ const r=await fetch('/share/'+slug+'/_raw?path='+encodeURIComponent(cur)); const j=await r.json(); fbody.value=j.content||''; fbody.disabled=false; }
      else { fbody.value='（二进制文件，不可在线编辑）'; fbody.disabled=true; }
      ed.hidden=false;
    }));
    document.getElementById('save').addEventListener('click', async ()=>{
      if(!cur||fbody.disabled) return;
      const res=await fetch('/share/'+slug+'/_file',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:cur,content:fbody.value})});
      if(res.ok){ const s=document.getElementById('save'); s.textContent='已保存 ✓'; setTimeout(()=>s.textContent='保存',900); }
      else { const j=await res.json().catch(()=>({})); alert(j.error||'保存失败'); }
    });`;
  return pageShell(`${resolveSite(ctx.db, share.target_id).name} · 文件`, inner, { script });
}

// ---- scoped blob --------------------------------------------------------------

function referencedHashes(ctx: RouteCtx, share: ShareRow): Set<string> {
  const out = new Set<string>();
  const scan = (text: string | null | undefined) => {
    if (!text) return;
    const re = /\/blob\/([0-9a-f]{16,64})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.add(m[1]!.toLowerCase());
  };
  if (share.kind === "doc") scan(getDocument(ctx.db, share.target_id)?.body);
  else if (share.kind === "database")
    for (const r of listRecords(ctx.db, share.target_id)) scan(JSON.stringify(r.cells));
  return out;
}

async function serveScopedBlob(ctx: RouteCtx, share: ShareRow, tail: string): Promise<Response> {
  const dot = tail.indexOf(".");
  const hash = (dot >= 0 ? tail.slice(0, dot) : tail).toLowerCase();
  if (!HASH_RE.test(hash)) return notFound();
  if (!referencedHashes(ctx, share).has(hash)) return notFound();
  const bytes = await resolveBlob(ctx.db, hash);
  if (!bytes) return notFound();
  const ct = dot >= 0 ? inferContentType(tail) : blobContentType(ctx.db, hash) ?? "application/octet-stream";
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return new Response(out.buffer, {
    headers: { "content-type": ct, "cache-control": "private, max-age=3600" },
  });
}

// ---- password session ---------------------------------------------------------

function shareSecret(ctx: RouteCtx): string {
  const row = ctx.db.query("SELECT value FROM meta WHERE key='share_cookie_secret'").get() as
    | { value: string }
    | null;
  if (row) return row.value;
  const secret = randomSuffix(32);
  ctx.db
    .query("INSERT INTO meta (key, value) VALUES ('share_cookie_secret', ?) ON CONFLICT(key) DO NOTHING")
    .run(secret);
  return (
    (ctx.db.query("SELECT value FROM meta WHERE key='share_cookie_secret'").get() as { value: string })
      .value
  );
}

const SHARE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Cookie mint/verify itself lives in guest-session.ts (portable), shared with
// the Durable Object room's unlock flow. This wrapper binds it to the share
// row + this node's meta-stored secret. Cookie value: `<exp>.<sub>.<mac>`
// where `sub` is the per-visitor guest sub-id minted at session start (final
// decision 2: one guest identity PER VISITOR — "who wrote this" is real data
// for family use, and rollback can target one person). `sub` is "" for
// read-only shares (no author identity). Pre-sub two-segment cookies simply
// fail verification → re-unlock/re-mint.
function shareSessionScope(ctx: RouteCtx, share: ShareRow): GuestSessionScope {
  return {
    secret: shareSecret(ctx),
    cookieName: "mh_share_" + share.slug,
    scopeKey: share.slug,
  };
}

async function readShareSession(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
): Promise<{ exp: number; sub: string } | null> {
  return readGuestSession(shareSessionScope(ctx, share), req.headers.get("cookie"));
}

/** Mint a fresh session (per-visitor sub id when the share can write) and the
 *  Set-Cookie header that persists it. */
async function mintShareSession(
  ctx: RouteCtx,
  share: ShareRow,
  url: URL,
): Promise<{ sub: string; cookie: string }> {
  const sub = share.guest_node_id ? `${share.guest_node_id}-${randomSuffix(6)}` : "";
  const minted = await mintGuestSession(shareSessionScope(ctx, share), {
    sub,
    ttlMs: Math.min(SHARE_SESSION_TTL_MS, ttlRemaining(share)),
    path: `/share/${share.slug}`,
    secure: url.protocol === "https:",
  });
  return { sub, cookie: minted.cookie };
}

/**
 * The guest author identity for one request's writes: the session's sub id
 * when a valid session cookie rides along; otherwise a freshly minted session
 * whose Set-Cookie the caller must attach to the response (browsers keep it —
 * later writes from the same visitor reuse one sub; a cookieless client gets a
 * per-request sub, which still rolls up under the share's base guest id via
 * the `<guest_node_id>-%` prefix).
 */
async function guestSessionFor(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
): Promise<{ sub: string; setCookie: string | null }> {
  const sess = await readShareSession(ctx, req, share);
  if (sess?.sub) return { sub: sess.sub, setCookie: null };
  const minted = await mintShareSession(ctx, share, new URL(req.url));
  return { sub: minted.sub || (share.guest_node_id ?? ""), setCookie: minted.cookie };
}

/** Attach a Set-Cookie to a handler response (fresh Response — some responses
 *  have immutable headers). */
function withSessionCookie(res: Response, setCookie: string | null): Response {
  if (!setCookie) return res;
  const headers = new Headers(res.headers);
  headers.append("set-cookie", setCookie);
  return new Response(res.body, { status: res.status, headers });
}

async function handleUnlock(
  ctx: RouteCtx,
  req: Request,
  share: ShareRow,
  url: URL,
): Promise<Response> {
  let pw = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) pw = String(((await req.json().catch(() => ({}))) as { password?: string }).password ?? "");
  else {
    const form = await req.formData().catch(() => null);
    pw = form ? String(form.get("password") ?? "") : "";
  }
  if (!(await verifySharePassword(share, pw))) {
    return new Response(passwordPage(share, true), { headers: HTML, status: 401 });
  }
  // Unlock mints the session — including this visitor's own guest sub id, so
  // every write of this session is attributed to one distinct author.
  const { cookie } = await mintShareSession(ctx, share, url);
  return new Response(null, {
    status: 303,
    headers: { location: `/share/${share.slug}`, "set-cookie": cookie },
  });
}

function ttlRemaining(share: ShareRow): number {
  return share.expires_at == null ? SHARE_SESSION_TTL_MS : Math.max(0, share.expires_at - Date.now());
}

// ---- page shell ---------------------------------------------------------------

function passwordPage(share: ShareRow, error: boolean): string {
  const inner = `
    <form method="post" action="/share/${share.slug}/unlock" class="pw">
      <h1>🔒 此分享受口令保护</h1>
      ${error ? '<p class="err">口令错误，请重试。</p>' : ""}
      <input type="password" name="password" placeholder="口令" autofocus autocomplete="current-password">
      <button type="submit">解锁</button>
    </form>`;
  return pageShell("受保护的分享", inner, { bare: true });
}

function pageShell(
  title: string,
  inner: string,
  opts: { editable?: boolean; editLabel?: string; script?: string; hint?: string; bare?: boolean } = {},
): string {
  const editBtn = opts.editable ? `<button id="mh-edit" class="edit-btn">${opts.editLabel ?? "编辑"}</button>` : "";
  const hint = opts.hint ? `<p class="hint">${escapeHtml(opts.hint)}</p>` : "";
  const script = opts.script ? `<script>(function(){${opts.script}})();</script>` : "";
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root{--bg:#ffffff;--fg:#1f2328;--muted:#6e7781;--line:#d0d7de;--accent:#0969da;--card:#f6f8fa}
  @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#4493f8;--card:#161b22}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  header.mh{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:14px}
  header.mh h1.title{font-size:22px;margin:0}
  .edit-btn{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:14px}
  .hint{color:var(--muted);font-size:13px;margin:0 0 14px}
  article.doc h1,article.doc h2,article.doc h3{line-height:1.3;margin:1.4em 0 .5em}
  article.doc h1{font-size:1.7em} article.doc h2{font-size:1.4em} article.doc h3{font-size:1.2em}
  article.doc p{margin:.7em 0} article.doc img{max-width:100%;border-radius:8px}
  article.doc pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto}
  article.doc code{background:var(--card);padding:.15em .35em;border-radius:4px;font-size:.9em}
  article.doc pre code{background:none;padding:0}
  article.doc blockquote{margin:.8em 0;padding:.2em 1em;border-left:3px solid var(--line);color:var(--muted)}
  article.doc table,table.db{border-collapse:collapse;width:100%;font-size:14px}
  article.doc td,article.doc th,table.db td,table.db th{border:1px solid var(--line);padding:7px 10px;text-align:left}
  table.db th{background:var(--card)}
  .table-wrap{overflow:auto}
  td[contenteditable]{outline:none} td.saving{opacity:.5} td.saved{background:rgba(46,160,67,.18)}
  .tag{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px}
  .muted{color:var(--muted)} .mh-img{text-align:center}
  .mh-media{text-align:center} .mh-media video,.mh-media audio{max-width:100%}
  .mh-file a{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;color:var(--accent);text-decoration:none}
  .mh-doclink{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:0 5px;white-space:nowrap}
  .mh-doclink::before{content:"📄";font-size:.85em;margin-right:3px}
  iframe.mh-embed{width:100%;border:1px solid var(--line);border-radius:8px;min-height:240px}
  textarea.mh-raw{width:100%;min-height:60vh;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
  ul.files{list-style:none;padding:0} ul.files li{padding:4px 0} button.file{background:none;border:0;color:var(--accent);cursor:pointer;font-size:15px;padding:0}
  .row{display:flex;gap:10px;align-items:center;margin:10px 0}
  form.pw{max-width:320px;margin:12vh auto 0;display:flex;flex-direction:column;gap:12px}
  form.pw input{padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg)}
  form.pw button{padding:9px;border:0;border-radius:7px;background:var(--accent);color:#fff;cursor:pointer}
  form.pw .err{color:#f85149;font-size:13px;margin:0}
  footer.mh{margin-top:48px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;text-align:center}
</style></head><body>
${opts.bare ? `<div class="wrap">${inner}</div>` : `<div class="wrap">
<header class="mh"><h1 class="title">${escapeHtml(title)}</h1>${editBtn}</header>
${hint}
${inner}
<footer class="mh">通过 metahub 分享</footer>
</div>`}
${script}
</body></html>`;
}
