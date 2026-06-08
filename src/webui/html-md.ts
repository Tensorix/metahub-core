// HTML clipboard -> Markdown, for paste. Browsers expose a structured
// `text/html` flavor alongside `text/plain` when copying from a rendered page
// (e.g. ChatGPT). The plain flavor has usually lost block markers — code-fence
// backticks, heading `#`, list indentation — so pasting it collapses code and
// headings into flat paragraphs. Converting the HTML instead reconstructs that
// structure, then `blocksFromBody` turns the Markdown into the editor's blocks.

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** Pull a code language out of a `language-xxx` / `lang-xxx` class, ignoring the
 *  other utility classes ChatGPT/highlight.js sprinkle on the element. */
function langFromClass(className: string): string {
  const m = className.match(/(?:language|lang)-(\S+)/);
  return m ? m[1]! : "";
}

function makeService(): TurndownService {
  const td = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  td.use(gfm);

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

let service: TurndownService | null = null;

/** Convert a clipboard `text/html` payload to Markdown text. */
export function htmlToMarkdown(html: string): string {
  service ??= makeService();
  return service.turndown(html);
}
