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
import { decryptBytes, deriveShareKey, fromB64 } from "../../core/sync/e2ee.ts";

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
      ph!.textContent = "附件已失效";
    }
  }
}

async function main() {
  const root = document.getElementById("app")!;
  const set = (html: string) => (root.innerHTML = html);
  try {
    const { m, k, s } = parseHash();
    if (!m) throw new Error("链接缺少分享数据");

    let key: Uint8Array;
    if (k) key = fromB64(k);
    else if (s) {
      const pw = window.prompt("请输入分享口令") ?? "";
      key = await deriveShareKey(pw, fromB64(s));
    } else throw new Error("链接缺少密钥");

    const enc = new Uint8Array(await (await fetch(m)).arrayBuffer());
    let json: string;
    try {
      json = new TextDecoder().decode(await decryptBytes(key, enc));
    } catch {
      throw new Error(s ? "口令错误或链接已失效" : "链接已失效或密钥不正确");
    }
    const manifest = JSON.parse(json) as Manifest;
    document.title = manifest.title || "分享";

    const title = `<header class="mh"><h1 class="title">${escapeHtml(manifest.title || "分享")}</h1></header>`;
    const inner =
      manifest.kind === "doc"
        ? `<article class="doc">${renderMarkdown(manifest.body ?? "") || '<p class="muted">（空文档）</p>'}</article>`
        : renderTable(manifest);
    const tpl = document.createElement("template");
    tpl.innerHTML = `<div class="mh-view">${title}${inner}<footer class="mh">通过 metahub 分享</footer></div>`;
    const wanted = detachBlobRefs(tpl.content);
    set("");
    root.append(tpl.content);

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
    set(`<p class="err">${escapeHtml((e as Error).message)}</p>`);
  }
}

void main();
