// Constrained inline markdown <-> HTML for the contenteditable block editor.
// Grammar (inline only; block structure lives in blocks.ts):
//   **bold**  *italic*  `code`  [text](url)
// inlineToHtml renders a block's content for editing/display; htmlToInline reads
// the edited contenteditable HTML back to markdown for serialization.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Private-use sentinels wrapping a code-span index; cannot occur in real input.
const A = String.fromCharCode(0xe000);
const B = String.fromCharCode(0xe001);
const RESTORE = new RegExp(A + "(\\d+)" + B, "g");

/** Markdown inline string -> HTML. Code spans are protected first. */
export function inlineToHtml(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return A + (codes.length - 1) + B;
  });
  s = escapeHtml(s);
  // Images first — `![alt](url)` contains a `[alt](url)` the link rule would
  // otherwise match. Doc images point at /blob/<hash>.<ext> (see blobs.ts).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, u) => {
    const url = String(u).replace(/"/g, "&quot;");
    return `<img src="${url}" alt="${alt}" class="doc-img" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
    const url = String(u).replace(/"/g, "&quot;");
    return `<a href="${url}" target="_blank" rel="noreferrer">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Newlines inside a block (multi-line quotes, soft breaks) render as <br> —
  // the editable has no white-space:pre-wrap, so a raw "\n" would display
  // collapsed. walk() maps <br> back to "\n", keeping the round-trip symmetric.
  s = s.replace(/\n/g, "<br>");
  s = s.replace(RESTORE, (_m, i) => `<code>${escapeHtml(codes[+i] ?? "")}</code>`);
  return s;
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
    else if (tag === "code") out += inner ? "`" + inner + "`" : "";
    else if (tag === "a") {
      const href = n.getAttribute("href") || "";
      out += href ? `[${inner}](${href})` : inner;
    } else if (tag === "div" || tag === "p") out += (out && !out.endsWith("\n") ? "\n" : "") + inner;
    else out += inner;
  });
  return out;
}
