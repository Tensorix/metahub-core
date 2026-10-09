// HTML clipboard -> Markdown, for paste. Browsers expose a structured
// `text/html` flavor alongside `text/plain` when copying from a rendered page
// (e.g. ChatGPT). The plain flavor has usually lost block markers — code-fence
// backticks, heading `#`, list indentation — so pasting it collapses code and
// headings into flat paragraphs. Converting the HTML instead reconstructs that
// structure.
//
// The output is the EDITOR's Markdown dialect, not CommonMark: one line is one
// block, a newline separates blocks, and a blank line is itself a (visible)
// empty block — exactly what typing Enter produces. Turndown pads every block
// with "\n\n" (CommonMark paragraph separators), which would surface as an
// empty row between every pasted paragraph / list item. So block separators
// are tightened to a single newline, and a blank line survives only where the
// source HTML had an explicit empty block (`<p></p>`, `<p><br></p>`, `&nbsp;`
// paragraphs, a `<br><br>` run). Fenced code bodies are left verbatim.

import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { fenceMask } from "../core/md/grammar.ts";

/** Marks a line the source explicitly left empty, so tightening keeps it.
 *  Private-use code point; any pre-existing occurrence is stripped from the
 *  input first so clipboard text can never forge one. */
const EMPTY_LINE = "";
const EMPTY_LINE_RE = //g;
/** Whitespace, NBSP and the other Unicode spaces `\s` already covers. */
const BLANK_TEXT = /^\s*$/;
/** Inline formatting shells that still leave a block visually empty. */
const INLINE_SHELL = /^(?:BR|SPAN|B|I|STRONG|EM|U|S|FONT)$/;

/** Pull a code language out of a `language-xxx` / `lang-xxx` class, ignoring the
 *  other utility classes ChatGPT/highlight.js sprinkle on the element. */
function langFromClass(className: string): string {
  const m = className.match(/(?:language|lang)-(\S+)/);
  return m ? m[1]! : "";
}

/** A `<p>` / `<div>` that renders as an empty line: no text (NBSP counts as
 *  none) and only `<br>` / inline-formatting descendants. Layout shells holding
 *  an `<svg>`, `<img>`, nested blocks etc. are not lines and get no blank. */
function isEmptyLine(node: Node): boolean {
  if (node.nodeName !== "P" && node.nodeName !== "DIV") return false;
  const el = node as HTMLElement;
  if (!BLANK_TEXT.test(el.textContent ?? "")) return false;
  for (const child of Array.from(el.querySelectorAll("*"))) {
    if (!INLINE_SHELL.test(child.nodeName)) return false;
  }
  return true;
}

/** The previous sibling that isn't whitespace-only text. */
function prevMeaningfulSibling(node: Node): Node | null {
  let prev = node.previousSibling;
  while (prev && prev.nodeType === 3 && BLANK_TEXT.test(prev.nodeValue ?? "")) prev = prev.previousSibling;
  return prev;
}

function makeService(): TurndownService {
  const td = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    br: "",
    blankReplacement: (_content, node) =>
      isEmptyLine(node) ? `\n\n${EMPTY_LINE}\n\n` : (node as { isBlock?: boolean }).isBlock ? "\n\n" : "",
  });
  td.use(gfm);

  // Cocoa's text/html clipboard flavor (TextEdit, native macOS text fields)
  // ships a <head><style>p.p1 {…}</style> block; Turndown keeps the text of
  // unknown elements by default, which would paste the CSS rules as prose.
  td.remove(["style", "script", "title"]);

  // Don't backslash-escape Markdown punctuation (` * _ 1. …). The editor's
  // parser/renderer has no concept of backslash escapes, so escaped output
  // surfaces as literal "\`" in the document. Leaving the characters bare makes
  // the HTML flavor behave exactly like the text/plain paste path: whatever
  // looks like Markdown is interpreted by the line grammar, the rest stays text.
  td.escape = (text: string) => text;

  // Turndown hands blank nodes to blankReplacement before any rule, so that
  // option covers `<p></p>` / `<p>&nbsp;</p>`; a `<p><br></p>` has a void child
  // and is NOT blank, so it needs a rule of its own.
  td.addRule("emptyLine", {
    filter: (node) => isEmptyLine(node),
    replacement: () => `\n\n${EMPTY_LINE}\n\n`,
  });

  // A `<br>` is a newline (= a new row). The second and later `<br>` of a run
  // each stand for an empty row the source showed, so they carry the marker.
  td.addRule("lineBreak", {
    filter: "br",
    replacement: (_content, node) => (prevMeaningfulSibling(node)?.nodeName === "BR" ? `${EMPTY_LINE}\n` : "\n"),
  });

  // The gfm plugin turns a <br> inside a table cell into a literal "<br>" so
  // the line break survives in Markdown, but our inline grammar has no HTML
  // pass-through — it would render as visible "<br>" text. A space loses the
  // break but keeps the cell readable. DOM-level match, so literal "<br>" text
  // in code blocks is untouched. Added after lineBreak: later rules win.
  td.addRule("brInTableCell", {
    filter: (node) => node.nodeName === "BR" && !!node.parentElement?.closest("td,th"),
    replacement: () => " ",
  });

  // Canonical list markers (`- ` / `1. `, one space) and a fixed 2-space
  // continuation indent — the editor's nesting unit (level = indent / 2) and
  // what its own serializer writes. Turndown's default pads markers to 4
  // columns and indents by that width, so a nested bullet came out two levels
  // deep. A `<li><p>…</p></li>` item no longer turns the list loose either.
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/^\[([ xX])\][ \t]+/, "[$1] ")
        .replace(/\n/gm, "\n  ");
      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode as HTMLElement | null;
      if (parent?.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });

  // Robust fenced-code rule: take the text from the inner <code>, not the whole
  // <pre>. ChatGPT wraps code blocks in a <pre> that also holds a header div
  // ("javascript" label + "Copy code" button); the default rule keys off
  // `pre > code` as the *first* child and would otherwise miss the language or
  // fold the toolbar text into the snippet.
  td.addRule("fencedCodeWithLang", {
    filter: (node) => node.nodeName === "PRE" && !!node.querySelector("code"),
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector("code");
      const text = (code?.textContent ?? (node as HTMLElement).textContent ?? "").replace(/\n$/, "");
      const lang = code ? langFromClass(code.className) : "";
      const fence = "```";
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  return td;
}

/** Collapse Turndown's CommonMark block spacing into the editor's line model:
 *  outside closed fences, drop every line that is only whitespace / quote
 *  markers (the separators), keep a line that carries the explicit-empty marker
 *  (minus the marker), and trim the ends. */
function tighten(md: string): string {
  const lines = md.split("\n");
  const inFence = fenceMask(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFence[i]) {
      out.push(line);
      continue;
    }
    if (line.includes(EMPTY_LINE)) {
      out.push(line.replace(EMPTY_LINE_RE, ""));
      continue;
    }
    if (/^[\s>]*$/.test(line)) continue;
    out.push(line);
  }
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

let service: TurndownService | null = null;

/** Convert a clipboard `text/html` payload to the editor's Markdown dialect. */
export function htmlToMarkdown(html: string): string {
  service ??= makeService();
  return tighten(service.turndown(html.replace(EMPTY_LINE_RE, "")));
}
