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

    set('<p class="muted">正在加载…</p>');
    const enc = new Uint8Array(await (await fetch(m)).arrayBuffer());
    let json: string;
    try {
      json = new TextDecoder().decode(await decryptBytes(key, enc));
    } catch {
      throw new Error(s ? "口令错误或链接已失效" : "链接已失效或密钥不正确");
    }
    const manifest = JSON.parse(json) as Manifest;
    document.title = manifest.title || "分享";

    // Resolve referenced blobs to in-memory object URLs (decrypt each).
    const blobUrls: Record<string, string> = {};
    for (const [hash, info] of Object.entries(manifest.blobs ?? {})) {
      try {
        const bytes = await decryptBytes(key, new Uint8Array(await (await fetch(info.url)).arrayBuffer()));
        blobUrls[hash] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: info.ct }));
      } catch {
        /* a missing/expired blob just renders broken — don't fail the whole page */
      }
    }
    const rewriteBlob = (u: string): string => {
      const mm = u.match(/\/blob\/([0-9a-f]{16,64})/);
      return mm && blobUrls[mm[1]!] ? blobUrls[mm[1]!]! : u;
    };

    const title = `<header class="mh"><h1 class="title">${escapeHtml(manifest.title || "分享")}</h1></header>`;
    const inner =
      manifest.kind === "doc"
        ? `<article class="doc">${renderMarkdown(manifest.body ?? "", { rewriteBlob }) || '<p class="muted">（空文档）</p>'}</article>`
        : renderTable(manifest);
    set(`${title}${inner}<footer class="mh">通过 metahub 分享</footer>`);
  } catch (e) {
    set(`<p class="err">${escapeHtml((e as Error).message)}</p>`);
  }
}

void main();
