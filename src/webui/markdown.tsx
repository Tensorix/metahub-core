// Constrained inline markdown <-> HTML for the contenteditable block editor.
// Grammar (inline only; block structure lives in blocks.ts):
//   **bold**/__bold__  *italic*/_italic_  ~~strike~~  `code`
//   [text](url)  ![alt](url)
// The grammar itself lives in inline-tokens.ts, shared with the CM6 editor and
// the TOC — this file only maps tokens to/from HTML. inlineToHtml renders a
// block's content for editing/display; htmlToInline reads the edited
// contenteditable HTML back to markdown for serialization.

import { tokenizeInline } from "./inline-tokens";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Newlines inside a block (multi-line quotes, soft breaks) render as <br> —
// the editable has no white-space:pre-wrap, so a raw "\n" would display
// collapsed. walk() maps <br> back to "\n", keeping the round-trip symmetric.
// Tokens never span a newline, so only plain segments need the mapping.
function emitText(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

/** Markdown inline string -> HTML, driven by the shared tokenizer (escape-aware,
 *  single-level; code spans are opaque, images outrank links). */
export function inlineToHtml(src: string): string {
  let out = "";
  let pos = 0;
  for (const t of tokenizeInline(src)) {
    out += emitText(src.slice(pos, t.start));
    pos = t.end;
    const inner = src.slice(t.innerFrom, t.innerTo);
    switch (t.kind) {
      case "code":
        out += `<code>${escapeHtml(inner)}</code>`;
        break;
      case "image": {
        // Doc images point at /blob/<hash>.<ext> (see blobs.ts).
        out += `<img src="${escapeHtml(t.url!)}" alt="${escapeHtml(t.alt ?? "")}" class="doc-img" loading="lazy">`;
        break;
      }
      case "link":
        out += `<a href="${escapeHtml(t.url!)}" target="_blank" rel="noreferrer">${escapeHtml(inner)}</a>`;
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
    }
  }
  out += emitText(src.slice(pos));
  return out;
}

/** ContentEditable HTML -> markdown inline string. */
export function htmlToInline(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  // A trailing newline is the browser's placeholder <br> (an emptied line keeps
  // one), not content — strip it so clearing a line yields "" instead of "\n".
  return walk(div).replace(/\n{3,}/g, "\n\n").replace(/\n$/, "");
}

function walk(node: Node): string {
  let out = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      // Browsers use NBSP for trailing/consecutive spaces in contentEditable;
      // normalize so invisible U+00A0 never reaches the saved Markdown.
      out += (n.textContent ?? "").replace(/\u00a0/g, " ");
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const tag = n.tagName.toLowerCase();
    if (tag === "img") {
      const src = n.getAttribute("src") || "";
      out += src ? `![${n.getAttribute("alt") || ""}](${src})` : "";
      return;
    }
    const inner = walk(n);
    if (tag === "br") out += "\n";
    else if (tag === "strong" || tag === "b") out += inner ? `**${inner}**` : "";
    else if (tag === "em" || tag === "i") out += inner ? `*${inner}*` : "";
    else if (tag === "del" || tag === "s" || tag === "strike") out += inner ? `~~${inner}~~` : "";
    else if (tag === "code") out += inner ? "`" + inner + "`" : "";
    else if (tag === "a") {
      const href = n.getAttribute("href") || "";
      out += href ? `[${inner}](${href})` : inner;
    } else if (tag === "div" || tag === "p") out += (out && !out.endsWith("\n") ? "\n" : "") + inner;
    else out += inner;
  });
  return out;
}
