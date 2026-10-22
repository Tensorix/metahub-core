// Static, data-blind viewer for object-storage shares (deployed to Cloudflare
// Pages / any static host). It receives the presigned manifest URL + the per-
// share key (or salt) in the URL fragment (#m=…&k=… / &s=…), fetches the
// ciphertext directly from the bucket, decrypts it in-browser, and renders with
// the SAME runtime-agnostic renderer the server uses (share-render.ts).
//
// Fetching the bytes via fetch() and rendering them ourselves is also what
// bypasses providers (Tencent COS) that force `Content-Disposition: attachment`
// on a top-level navigation — we never navigate to the object, we read it.

import { renderMarkdown, escapeHtml } from "../../core/sync/share-render.ts";
import { copyButtonHtml, copySourceHtml, copyScript, markdownTable } from "../../core/sync/share-copy.ts";
import { decryptBytes, deriveShareKey, fromB64 } from "../../core/sync/e2ee.ts";
import { localeFromTags } from "../../core/sync/locale.ts";
import { pm, type PageMsgKey } from "../../core/sync/page-messages.ts";

const LOCALE = localeFromTags(navigator.languages?.length ? navigator.languages : [navigator.language]);
const m = (key: PageMsgKey) => pm(LOCALE, key);
const brandMark = `<picture class="share-brand-mark" aria-hidden="true"><source media="(prefers-color-scheme:dark)" srcset="./brand-dark.png"><img src="./brand-light.png" width="192" height="192" alt=""></picture>`;

interface Manifest {
  v: 1;
  kind: "doc" | "database";
  title: string;
  body?: string;
  properties?: { id: string; name: string; type: string }[];
  records?: { cells: Record<string, unknown> }[];
  blobs?: Record<string, { url: string; ct: string }>;
}

/** Manual fragment parse: only `m` is percent-encoded (it's a full URL); `k`/`s`
 *  are raw base64 left untouched (URLSearchParams would turn '+' into a space). */
function parseHash(): { m?: string; k?: string; s?: string } {
  const out: Record<string, string> = {};
  for (const part of location.hash.replace(/^#/, "").split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return { m: out.m ? decodeURIComponent(out.m) : undefined, k: out.k, s: out.s };
}

function cellHtml(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value ? "✓" : "";
  if (type === "url") {
    const s = String(value);
    return `<a href="${escapeHtml(s)}" target="_blank" rel="noreferrer noopener">${escapeHtml(s)}</a>`;
  }
  if (Array.isArray(value)) return value.map((v) => `<span class="tag">${escapeHtml(String(v))}</span>`).join(" ");
  return escapeHtml(String(value));
}

function cellPlain(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value ? "✓" : "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

function renderTable(m: Manifest): string {
  const props = m.properties ?? [];
  const head = props.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("");
  const rows = (m.records ?? [])
    .map((r) => `<tr>${props.map((p) => `<td>${cellHtml(p.type, r.cells[p.id])}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table class="db"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const BLOB_RE = /\/blob\/([0-9a-f]{16,64})/;

function detachBlobRefs(frag: DocumentFragment): Set<string> {
  const hashes = new Set<string>();
  let i = 0;
  for (const el of Array.from(frag.querySelectorAll<HTMLElement>("img[src], video[src], audio[src], a[href]"))) {
    const attr = el.tagName === "A" ? "href" : "src";
    const m = el.getAttribute(attr)?.match(BLOB_RE);
    if (!m) continue;
    const hash = m[1]!.toLowerCase();
    hashes.add(hash);
    el.dataset.blob = hash;
    el.removeAttribute(attr);
    if (el.tagName === "IMG") {
      const ph = document.createElement("span");
      ph.className = "skel-b skel-media";
      ph.style.setProperty("--i", String(Math.min(i++, 4)));
      el.before(ph);
      el.hidden = true;
    } else if (el.tagName === "A") {
      el.setAttribute("aria-disabled", "true");
    }
  }
  return hashes;
}

function attachBlob(hash: string, url: string | null): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-blob="${hash}"]`))) {
    const ph = el.previousElementSibling;
    const isPh = ph?.classList.contains("skel-media");
    if (url) {
      el.setAttribute(el.tagName === "A" ? "href" : "src", url);
      el.removeAttribute("aria-disabled");
      el.hidden = false;
      if (isPh) ph!.remove();
    } else if (isPh) {
      ph!.classList.add("dead");
      ph!.textContent = m("附件已失效");
    }
  }
}

async function main() {
  const root = document.getElementById("app")!;
  const set = (html: string) => (root.innerHTML = html);
  try {
    const { m: manifestUrl, k, s } = parseHash();
    if (!manifestUrl) throw new Error(pm(LOCALE, "链接缺少分享数据"));

    let key: Uint8Array;
    if (k) key = fromB64(k);
    else if (s) {
      const pw = window.prompt(pm(LOCALE, "请输入分享口令")) ?? "";
      key = await deriveShareKey(pw, fromB64(s));
    } else throw new Error(pm(LOCALE, "链接缺少密钥"));

    const enc = new Uint8Array(await (await fetch(manifestUrl)).arrayBuffer());
    let json: string;
    try {
      json = new TextDecoder().decode(await decryptBytes(key, enc));
    } catch {
      throw new Error(pm(LOCALE, s ? "口令错误或链接已失效" : "链接已失效或密钥不正确"));
    }
    const manifest = JSON.parse(json) as Manifest;
    document.title = manifest.title || pm(LOCALE, "分享");

    const title = `<header class="mh"><h1 class="title" id="share-title">${escapeHtml(manifest.title || pm(LOCALE, "分享"))}</h1></header>`;
    const copySource =
      manifest.kind === "doc"
        ? manifest.body ?? ""
        : markdownTable(
            (manifest.properties ?? []).map((p) => p.name),
            (manifest.records ?? []).map((r) => (manifest.properties ?? []).map((p) => cellPlain(p.type, r.cells[p.id]))),
          );
    const inner =
      manifest.kind === "doc"
        ? `<article class="doc">${renderMarkdown(manifest.body ?? "") || `<p class="muted">${escapeHtml(pm(LOCALE, "（空文档）"))}</p>`}</article>`
        : renderTable(manifest);
    const tpl = document.createElement("template");
    tpl.innerHTML = `<div class="mh-view"><div class="share-topbar"><div class="share-brand">${brandMark}<span>metahub</span></div><div class="mh-tools">${copyButtonHtml(LOCALE)}</div></div><main class="share-content" aria-labelledby="share-title">${title}${inner}</main><footer class="mh">${escapeHtml(pm(LOCALE, "通过 metahub 分享"))}</footer>${copySourceHtml(copySource)}</div>`;
    const wanted = detachBlobRefs(tpl.content);
    set("");
    root.append(tpl.content);
    const js = document.createElement("script");
    js.textContent = copyScript(LOCALE);
    root.append(js);

    await Promise.allSettled(
      Object.entries(manifest.blobs ?? {})
        .filter(([hash]) => wanted.has(hash.toLowerCase()))
        .map(async ([hash, info]) => {
          try {
            const bytes = await decryptBytes(key, new Uint8Array(await (await fetch(info.url)).arrayBuffer()));
            attachBlob(hash.toLowerCase(), URL.createObjectURL(new Blob([bytes as BlobPart], { type: info.ct })));
          } catch {
            attachBlob(hash.toLowerCase(), null);
          }
        }),
    );
    for (const hash of wanted) if (!manifest.blobs?.[hash]) attachBlob(hash, null);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const incomplete = reason === m("链接缺少分享数据") || reason === m("链接缺少密钥") || e instanceof URIError;
    document.title = `${m("无法打开这份分享")} · metahub`;
    set(`<div class="share-error">
      <header class="share-error-brand">${brandMark}<span>metahub</span></header>
      <main class="share-error-main" aria-labelledby="share-error-title">
        <div class="share-error-emblem">${brandMark}<svg class="share-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 13-1 1a4 4 0 0 1-6-6l3-3a4 4 0 0 1 6 0m2 6 1-1a4 4 0 0 1 6 6l-3 3a4 4 0 0 1-6 0M3 21l3-3M18 6l3-3"/></svg></div>
        <h1 id="share-error-title">${escapeHtml(m("无法打开这份分享"))}</h1>
        <p class="share-error-reason" role="alert">${escapeHtml(reason)}</p>
        <div class="share-error-help"><p>${escapeHtml(m(incomplete ? "请从原消息中重新复制完整链接，再打开试试。" : "请检查网络连接后重试，或联系分享者确认链接是否仍然有效。"))}</p>
        ${incomplete ? `<p>${escapeHtml(m("如果仍然无法打开，请联系分享者重新发送链接。"))}</p>` : ""}</div>
        ${incomplete ? "" : `<button class="share-error-retry" type="button">${escapeHtml(m("重新加载"))}</button>`}
      </main>
      <footer class="mh">${escapeHtml(m("通过 metahub 分享"))}</footer>
    </div>`);
    root.querySelector(".share-error-retry")?.addEventListener("click", () => location.reload());
  }
}

void main();
