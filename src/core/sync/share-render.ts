// Runtime-agnostic Markdown → HTML rendering for read-only share pages. Pure
// string ops (no DOM, no node:* — usable both server-side in serveShare and in
// the static Cloudflare-Pages viewer that decrypts an s3 bundle in the browser).
//
// This is a deliberately small block renderer covering the document model
// (headings, lists, code fences, quotes, rules, pipe tables, paragraphs with
// inline bold/italic/code/link/image). It is NOT a full CommonMark engine — the
// editor's own block model is the source of truth; this just presents it.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface RenderOpts {
  /** Rewrite a `/blob/<hash>` URL to a reachable one (scoped endpoint or data URL). */
  rewriteBlob?: (url: string) => string;
}

// Private-use sentinels wrapping a protected code-span index (mirrors markdown.tsx).
const A = String.fromCharCode(0xe000);
const B = String.fromCharCode(0xe001);
const RESTORE = new RegExp(A + "(\\d+)" + B, "g");

/** Inline Markdown → HTML: `code`, **bold**, *italic*, [link](url), ![img](url). */
export function renderInline(src: string, opts: RenderOpts = {}): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return A + (codes.length - 1) + B;
  });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, u) => {
    const url = rewrite(String(u), opts).replace(/"/g, "&quot;");
    return `<img src="${url}" alt="${escapeHtml(String(alt))}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const url = rewrite(String(u), opts).replace(/"/g, "&quot;");
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(RESTORE, (_m, i) => `<code>${escapeHtml(codes[+i] ?? "")}</code>`);
  return s;
}

function rewrite(url: string, opts: RenderOpts): string {
  if (opts.rewriteBlob && url.startsWith("/blob/")) return opts.rewriteBlob(url);
  return url;
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** Render a markdown body to an HTML string (block-level). */
export function renderMarkdown(md: string, opts: RenderOpts = {}): string {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((l) => renderInline(l, opts)).join("<br>")}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block (``` or ~~~). Info string `mh-html` renders as a
    // sandboxed iframe; everything else as <pre><code>.
    const fence = line.match(FENCE);
    if (fence) {
      flushPara();
      const marker = fence[1]![0];
      const info = (fence[2] ?? "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const m = lines[i]!.match(/^\s*(`{3,}|~{3,})\s*$/);
        if (m && m[1]![0] === marker) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      if (info === "mh-html") {
        out.push(
          `<iframe class="mh-embed" sandbox="allow-scripts allow-popups" srcdoc="${escapeHtml(
            body.join("\n"),
          )}"></iframe>`,
        );
      } else {
        const cls = info ? ` class="language-${escapeHtml(info)}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      }
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    // ATX heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1]!.length;
      out.push(`<h${level}>${renderInline(h[2]!.trim(), opts)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote: consecutive quote lines. Strict rule shared with the editor
    // grammar (webui blocks.ts RE.quote): `>` must be followed by a space/tab —
    // or be the whole line (an empty quote line, which the editor's serializer
    // emits) — to count; `>foo` is a paragraph on every surface.
    if (/^\s*>(?:[ \t]|$)/.test(line)) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length && /^\s*>(?:[ \t]|$)/.test(lines[i]!)) {
        q.push(lines[i]!.replace(/^\s*>[ \t]?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(q.join("\n"), opts)}</blockquote>`);
      continue;
    }

    // Pipe table: a header row followed by a |---|---| separator.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      flushPara();
      const rows: string[][] = [];
      const head = splitRow(line);
      i += 2; // skip header + separator
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const th = head.map((c) => `<th>${renderInline(c, opts)}</th>`).join("");
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, opts)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Unordered / ordered list: consecutive matching item lines.
    const ul = line.match(/^\s*[-*+]\s+/);
    const ol = line.match(/^\s*\d+[.)]\s+/);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      // Ordered items carry their LITERAL number as `value` — the editor treats
      // source numbers as authoritative (1,1,7 renders as 1,1,7), so the share
      // page must not let the browser renumber sequentially.
      const items: { text: string; value?: number }[] = [];
      const re = ordered ? /^\s*(\d+)[.)]\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && re.test(lines[i]!)) {
        const m = lines[i]!.match(re)!;
        items.push({ text: lines[i]!.replace(re, ""), value: ordered ? Number(m[1]) : undefined });
        i++;
      }
      const lis = items
        .map((it) => `<li${it.value !== undefined ? ` value="${it.value}"` : ""}>${renderInline(it.text, opts)}</li>`)
        .join("");
      out.push(ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`);
      continue;
    }

    // Standalone image line → block image (avoid wrapping in <p>).
    if (/^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line)) {
      flushPara();
      out.push(`<p class="mh-img">${renderInline(line.trim(), opts)}</p>`);
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("\n");
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
