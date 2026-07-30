// Runtime-agnostic Markdown → HTML rendering for read-only share pages. Pure
// string ops (no DOM, no node:* — usable both server-side in serveShare and in
// the static Cloudflare-Pages viewer that decrypts an s3 bundle in the browser).
//
// This is a deliberately small block renderer covering the document model — it
// is NOT a CommonMark engine. Every classification goes through the shared
// grammar (core/md/grammar.ts) and the shared inline tokenizer (core/md/
// inline.ts), the same predicates the editor scan and the save parser use, so
// the same bytes can never render as different blocks on different surfaces
// (pinned by webui/cm6/grammar-parity.test.ts). Legacy marker forms heal at
// this read boundary too (core/md/heal.ts).

import {
  RE,
  HTML_FENCE,
  cleanLang,
  isFenceClose,
  looksLikeTableAt,
  matchListLine,
  matchMediaEmbed,
  matchQuoteLine,
  safeUrl,
  splitTableRow,
  stripIndent,
  type MediaLine,
} from "../md/grammar.ts";
import { tokenizeInline } from "../md/inline.ts";
import { healLegacyMarkdown } from "../md/heal.ts";
import { escapeHtml } from "./html-escape.ts";

// Re-exported so existing importers (sites-serve) keep resolving it from here.
export { escapeHtml };

export interface RenderOpts {
  /** Rewrite a `/blob/<hash>` URL to a reachable one (scoped endpoint or data URL). */
  rewriteBlob?: (url: string) => string;
  /** Resolve a `[[doc_x]]` internal reference to its current title. Absent (or
   *  returning null) the reference renders as its alias/id. Share pages render
   *  doclinks as inert text either way: auto-linking to the target's own share
   *  would extend one share's capability with another's. */
  resolveDocLink?: (id: string) => { title: string } | null;
}

/** Inline Markdown → HTML: a pure function of the shared tokenizer. Gaps are
 *  escaped text; each token maps to one tag shape (the parity test's oracle
 *  mirrors this table exactly). */
export function renderInline(src: string, opts: RenderOpts = {}): string {
  const tokens = tokenizeInline(src);
  let out = "";
  let pos = 0;
  for (const t of tokens) {
    out += escapeHtml(src.slice(pos, t.start));
    const inner = src.slice(t.innerFrom, t.innerTo);
    const rawUrl = rewrite(t.url ?? "", opts);
    switch (t.kind) {
      case "code":
        out += `<code>${escapeHtml(inner)}</code>`;
        break;
      case "strong":
        out += `<strong>${escapeHtml(inner)}</strong>`;
        break;
      case "em":
        out += `<em>${escapeHtml(inner)}</em>`;
        break;
      case "del":
        out += `<del>${escapeHtml(inner)}</del>`;
        break;
      case "link": {
        // Whitelist the scheme so a hostile `javascript:`/`data:text/html` href
        // from a shared doc can't execute when a page visitor clicks it, and
        // escapeHtml (not just quote-escaping) so an entity-encoded scheme like
        // `&#106;avascript:` can't be decoded back to `javascript:` in the attr.
        const href = escapeHtml(safeUrl(rawUrl));
        out += `<a href="${href}" target="_blank" rel="noreferrer noopener">${escapeHtml(inner)}</a>`;
        break;
      }
      case "image": {
        const imgSrc = escapeHtml(safeUrl(rawUrl, { allowData: true }));
        out += `<img src="${imgSrc}" alt="${escapeHtml(t.alt ?? "")}" loading="lazy">`;
        break;
      }
      case "doclink": {
        // Inert on share pages (see RenderOpts.resolveDocLink). Label precedence:
        // explicit alias > live title > raw id.
        const label = t.alias ?? opts.resolveDocLink?.(t.id!)?.title ?? t.id!;
        out += `<span class="mh-doclink">${escapeHtml(label)}</span>`;
        break;
      }
    }
    pos = t.end;
  }
  return out + escapeHtml(src.slice(pos));
}

function rewrite(url: string, opts: RenderOpts): string {
  if (opts.rewriteBlob && url.startsWith("/blob/")) return opts.rewriteBlob(url);
  return url;
}

/** Render a standalone non-image media/file embed by kind, so video/audio play
 *  and a file becomes a download link instead of degrading to a broken <img> or
 *  a bare hyperlink (image is rendered inline by the caller). */
function renderMedia(m: MediaLine, opts: RenderOpts): string {
  const raw = rewrite(m.src, opts);
  if (m.kind === "video") {
    const src = escapeHtml(safeUrl(raw, { allowData: true }));
    return `<p class="mh-media"><video src="${src}" controls preload="metadata"></video></p>`;
  }
  if (m.kind === "audio") {
    const src = escapeHtml(safeUrl(raw, { allowData: true }));
    return `<p class="mh-media"><audio src="${src}" controls preload="metadata"></audio></p>`;
  }
  // file
  const href = escapeHtml(safeUrl(raw));
  return `<p class="mh-file"><a href="${href}" download>${escapeHtml(m.name || "file")}</a></p>`;
}

/** Render a markdown body to an HTML string (block-level). */
export function renderMarkdown(md: string, opts: RenderOpts = {}): string {
  const healed = healLegacyMarkdown((md ?? "").replace(/\r\n?/g, "\n"));
  const lines = healed.split("\n");
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

    // Fenced code block (``` or ~~~). Editor semantics via the shared rules:
    // the closer must repeat the opener's character at least as many times
    // (isFenceClose), and an UNCLOSED opener is prose, not code-to-EOF — so the
    // fence branch only fires when a closer exists.
    const fence = line.match(RE.fenceOpen);
    if (fence) {
      const marker = fence[1]![0]!;
      const len = fence[1]!.length;
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isFenceClose(lines[j]!, marker, len)) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        flushPara();
        const info = cleanLang(fence[2] ?? "");
        const body = lines.slice(i + 1, close);
        i = close + 1;
        if (info === HTML_FENCE) {
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
    }

    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    // ATX heading. Strip nesting indent first (RE.h is anchored flush-left by
    // contract): an indented `  # x` is a heading in the editor scan, so it must
    // be one here and in rich copy too.
    const h = stripLead(line).match(RE.h);
    if (h) {
      flushPara();
      const level = h[1]!.length;
      out.push(`<h${level}>${renderInline(h[2]!.trim(), opts)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule. Strict (shared RE.divider): no interior spaces —
    // "- - -" is a bullet whose content is "- -", exactly like the editor.
    if (RE.divider.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote: consecutive quote lines through the shared predicate
    // (`>` + space/tab; a bare `>` or `>foo` is a paragraph on every surface).
    if (matchQuoteLine(stripLead(line)) !== null) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length) {
        const content = matchQuoteLine(stripLead(lines[i]!));
        if (content === null) break;
        q.push(content);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(q.join("\n"), opts)}</blockquote>`);
      continue;
    }

    // Pipe table: shared strict check — header row + delimiter row whose every
    // cell matches `:?-+:?` (the editor rejects anything looser, so must we).
    if (looksLikeTableAt(lines, i, 0)) {
      flushPara();
      const rows: string[][] = [];
      const head = splitTableRow(stripLead(lines[i]!));
      i += 2; // skip header + delimiter
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(stripLead(lines[i]!)));
        i++;
      }
      const th = head.map((c) => `<th>${renderInline(c, opts)}</th>`).join("");
      const body = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, opts)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // List run: consecutive lines the shared list predicate accepts, split
    // whenever orderedness flips (a bullet run and a numbered run are separate
    // lists). Todos render as real checkboxes; ordered items carry their
    // LITERAL number as `value` — the editor treats source numbers as
    // authoritative, so the share page must not let the browser renumber.
    const first = matchListLine(line, 0);
    if (first) {
      flushPara();
      const ordered = first.type === "numbered";
      const lis: string[] = [];
      while (i < lines.length) {
        const it = matchListLine(lines[i]!, 0);
        if (!it || (it.type === "numbered") !== ordered) break;
        if (it.type === "todo") {
          lis.push(
            `<li class="todo"><input type="checkbox" disabled${it.checked ? " checked" : ""}> ${renderInline(it.content, opts)}</li>`,
          );
        } else if (it.type === "numbered" && it.num !== undefined) {
          lis.push(`<li value="${it.num}">${renderInline(it.content, opts)}</li>`);
        } else {
          lis.push(`<li>${renderInline(it.content, opts)}</li>`);
        }
        i++;
      }
      out.push(ordered ? `<ol>${lis.join("")}</ol>` : `<ul>${lis.join("")}</ul>`);
      continue;
    }

    // Standalone media/file embed → its own block (the same predicate the editor
    // scan and save parser use). Image renders inline as before; video/audio/file
    // render by kind so they don't degrade to a broken <img> or a bare link.
    const media = matchMediaEmbed(line);
    if (media) {
      flushPara();
      out.push(
        media.kind === "image"
          ? `<p class="mh-img">${renderInline(line.trim(), opts)}</p>`
          : renderMedia(media, opts),
      );
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("\n");
}

/** Strip leading whitespace (indent) — quote/table cells tolerate nesting
 *  indent on the share page like the editor render does. */
function stripLead(line: string): string {
  return stripIndent(line, Number.MAX_SAFE_INTEGER);
}
