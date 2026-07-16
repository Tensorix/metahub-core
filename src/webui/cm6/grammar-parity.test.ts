// Grammar parity across every rendering surface. The line grammar lives in
// core/md/grammar.ts (re-exported by webui/blocks.ts) and BOTH the CM6 editor
// render (scanDoc/classifyLine) and the share page (core/sync/share-render.ts)
// must classify a line exactly like the save parser (blocksFromBody) does —
// otherwise the same text renders as different block types in the editor, on
// the share page, and on other devices. The tables below enumerate EVERY role
// (not samples): single-line roles, the multi-line constructs (fences, tables),
// and the inline grammar, so any re-fork fails loudly.
//
// Strict semantics (approved): EVERY marker needs trailing whitespace — nothing
// renders as a block until the space commits it. `- `/`1. `/`> ` (empty items,
// the serializer's own output) are blocks; bare `-`/`1.`/`>` are the mid-typing
// paragraph state; `-foo`/`1.foo`/`>foo` are paragraphs.
//
// INDENT: classification is indent-blind on every surface — a line keeps its
// role at any leading indent (2 columns = 1 nesting level, the 24px grid). The
// indented cases below pin that three-way: scanDoc strips per line, the save
// parser records Block.indent, share strips before classifying.

import { test, expect } from "bun:test";
import { scanDoc } from "./blockmodel";
import { blocksFromBody } from "../blocks";
import { renderMarkdown, renderInline, escapeHtml } from "../../core/sync/share-render";
import { tokenizeInline } from "../../core/md/inline";

type Kind = "quote" | "bullet" | "numbered" | "todo" | "p" | "divider" | "h1" | "h2" | "h6";

const CASES: [line: string, kind: Kind][] = [
  ["> x", "quote"],
  [">x", "p"],
  [">", "p"], // bare marker (mid-typing) — paragraph everywhere
  ["> ", "quote"], // empty quote line: marker + trailing space (serializer form)
  ["- x", "bullet"],
  ["-x", "p"],
  ["-", "p"], // bare marker (mid-typing) — paragraph everywhere
  ["- ", "bullet"], // empty item: marker + trailing space
  ["1. x", "numbered"],
  ["1.x", "p"],
  ["1.", "p"],
  ["1. ", "numbered"],
  ["* x", "bullet"],
  ["*x", "p"],
  // todo: whitespace after `]` required; bare `- [ ]` is a bullet with literal content
  ["- [ ] x", "todo"],
  ["- [x] x", "todo"],
  ["- [ ] ", "todo"], // serializer's empty todo
  ["- [ ]", "bullet"], // mid-typing
  ["- [X] x", "todo"],
  // headings
  ["# x", "h1"],
  ["#x", "p"],
  ["## x", "h2"],
  ["###### x", "h6"],
  // dividers: 3+ of one glyph, NO interior spaces ("- - -" is a bullet)
  ["---", "divider"],
  ["----", "divider"],
  ["***", "divider"],
  ["___", "divider"],
  ["- - -", "bullet"],
  // indented lines keep their role on every surface (free-standing nesting)
  ["  # x", "h1"],
  ["  > x", "quote"],
  ["  - x", "bullet"],
  ["  ---", "divider"],
];

/** Opening tag renderMarkdown must emit for each kind. */
const HTML_TAG: Record<Kind, string> = {
  quote: "<blockquote",
  bullet: "<ul",
  numbered: "<ol",
  todo: "<ul",
  p: "<p",
  divider: "<hr",
  h1: "<h1",
  h2: "<h2",
  h6: "<h6",
};

for (const [line, kind] of CASES) {
  test(`parity: ${JSON.stringify(line)} is "${kind}" on editor, save, and share surfaces`, () => {
    // 1) CM6 editor render (scanDoc → LineInfo.role; roles share the kind names)
    expect(scanDoc(line).lines[0]!.role).toBe(kind);
    // 2) save/load parser (block type of the first parsed block)
    expect(blocksFromBody(line)[0]!.type).toBe(kind);
    // 3) share page renderer (block-level HTML tag)
    expect(renderMarkdown(line).startsWith(HTML_TAG[kind])).toBe(true);
  });
}

// ---- todo rendering detail: real checkbox, checked tracks [x] ----

test("share: todo renders a disabled checkbox, not literal brackets", () => {
  const html = renderMarkdown("- [ ] task");
  expect(html).toContain('class="todo"');
  expect(html).toContain("<input");
  expect(html).not.toContain("[ ]");
});

test("share: [x] renders checked, [ ] does not", () => {
  expect(renderMarkdown("- [x] done")).toContain(" checked");
  expect(renderMarkdown("- [ ] open")).not.toContain(" checked");
});

test("share: ordered items keep their literal numbers (value=)", () => {
  expect(renderMarkdown("3. x")).toContain('value="3"');
});

test("share: a bullet run and a numbered run stay separate lists", () => {
  const html = renderMarkdown("- a\n1. b");
  expect(html).toContain("<ul>");
  expect(html).toContain("<ol>");
});

// ---- multi-line constructs ----

test("parity: closed fence is code on all surfaces", () => {
  const doc = "```js\nx()\n```";
  expect(scanDoc(doc).voids[0]?.kind).toBe("code");
  expect(blocksFromBody(doc)[0]!.type).toBe("code");
  expect(renderMarkdown(doc)).toContain('<pre><code class="language-js">');
});

test("parity: UNCLOSED fence is prose everywhere (editor semantics)", () => {
  const doc = "```js\nx()";
  expect(scanDoc(doc).lines.map((l) => l.role)).toEqual(["p", "p"]);
  expect(blocksFromBody(doc).every((b) => b.type === "p")).toBe(true);
  expect(renderMarkdown(doc)).not.toContain("<pre");
});

test("parity: a media line right after prose (no blank) is its own block on all surfaces", () => {
  const doc = "caption\n![shot](/blob/abcdef0123456789.png)";
  // editor scan: a prose line + an image void (two blocks)
  const scan = scanDoc(doc);
  expect(scan.lines.map((l) => l.role)).toEqual(["p", "void"]);
  expect(scan.voids.map((v) => v.kind)).toEqual(["image"]);
  // save parser: must NOT fold the image into the caption paragraph
  expect(blocksFromBody(doc).map((b) => b.type)).toEqual(["p", "image"]);
  // share render: caption paragraph + image block
  const html = renderMarkdown(doc);
  expect(html).toContain("<p>caption</p>");
  expect(html).toContain('class="mh-img"');
});

test("share: standalone video/audio/file render by kind, not a broken img or bare link", () => {
  expect(renderMarkdown("![clip](/blob/deadbeefdeadbeef.mp4)")).toContain("<video");
  expect(renderMarkdown("![tune](/blob/deadbeefdeadbeef.mp3)")).toContain("<audio");
  const file = renderMarkdown('[report.zip](/blob/feedfacefeedface.zip "10240")');
  expect(file).toContain('class="mh-file"');
  expect(file).toContain("download");
});

test("parity: fence close must be at least the opener's length", () => {
  // ```` opened; a ``` line does NOT close it (editor scans one 4-line void).
  const doc = "````\ncode\n```\n````";
  const v = scanDoc(doc).voids[0]!;
  expect([v.fromLine, v.toLine]).toEqual([1, 4]);
  const html = renderMarkdown(doc);
  expect(html.match(/<pre/g)?.length ?? 0).toBe(1);
  expect(html).toContain("```"); // the short closer is code CONTENT
});

test("parity: an INDENTED fence is code on all surfaces, content stays clean", () => {
  const doc = "  ```js\n  x()\n  ```";
  expect(scanDoc(doc).voids[0]?.kind).toBe("code");
  const b = blocksFromBody(doc)[0]!;
  expect(b.type).toBe("code");
  expect(b.indent).toBe(1);
  expect(b.content).toBe("x()"); // fence indent must not leak into the code
  expect(renderMarkdown(doc)).toContain('<pre><code class="language-js">');
});

test("parity: an INDENTED table is a table on all surfaces", () => {
  const doc = "  | a |\n  | --- |\n  | 1 |";
  expect(scanDoc(doc).voids[0]?.kind).toBe("table");
  const b = blocksFromBody(doc)[0]!;
  expect(b.type).toBe("table");
  expect(b.indent).toBe(1);
  expect(renderMarkdown(doc)).toContain("<table>");
});

test("parity: mh-html fence renders as sandboxed iframe on share", () => {
  const doc = "```mh-html\n<b>hi</b>\n```";
  expect(scanDoc(doc).voids[0]?.kind).toBe("html");
  expect(blocksFromBody(doc)[0]!.type).toBe("html");
  expect(renderMarkdown(doc)).toContain("<iframe");
});

test("parity: table needs a STRICT delimiter row on all surfaces", () => {
  const good = "| a |\n| --- |\n| 1 |";
  expect(scanDoc(good).voids[0]?.kind).toBe("table");
  expect(blocksFromBody(good)[0]!.type).toBe("table");
  expect(renderMarkdown(good)).toContain("<table>");
  // "|- -|" is not a valid delimiter cell (editor rejects) — share must too.
  const bad = "| a |\n|- -|";
  expect(scanDoc(bad).voids.length).toBe(0);
  expect(renderMarkdown(bad)).not.toContain("<table>");
});

// ---- inline grammar parity ----
// renderInline must be a pure function of tokenizeInline: the oracle below maps
// tokens to the exact tag shapes share-render uses. Any hand-tuned regex that
// drifts from the tokenizer (escapes, __strong__, ~~del~~, nesting rules) fails
// this corpus.

function inlineOracle(src: string): string {
  const tokens = tokenizeInline(src);
  let out = "";
  let pos = 0;
  for (const t of tokens) {
    out += escapeHtml(src.slice(pos, t.start));
    const inner = src.slice(t.innerFrom, t.innerTo);
    const url = (t.url ?? "").replace(/"/g, "&quot;");
    switch (t.kind) {
      case "code": out += `<code>${escapeHtml(inner)}</code>`; break;
      case "strong": out += `<strong>${escapeHtml(inner)}</strong>`; break;
      case "em": out += `<em>${escapeHtml(inner)}</em>`; break;
      case "del": out += `<del>${escapeHtml(inner)}</del>`; break;
      case "link": out += `<a href="${url}" target="_blank" rel="noreferrer noopener">${escapeHtml(inner)}</a>`; break;
      case "image": out += `<img src="${url}" alt="${escapeHtml(t.alt ?? "")}" loading="lazy">`; break;
    }
    pos = t.end;
  }
  return out + escapeHtml(src.slice(pos));
}

const INLINE_CORPUS = [
  "plain text",
  "**b**",
  "__b__",
  "*i*",
  "_i_",
  "~~gone~~",
  "`code`",
  "`**not bold**`",
  "\\*not em\\*",
  "\\**still escaped",
  "**bold** and *em* and ~~del~~",
  "[t](https://x.dev)",
  "![alt](/blob/abc)",
  "![](/blob/abc)",
  "a**b**c",
  "*a**b*",
  "**a*b**",
  "_snake_case_ words",
  "text with <html> & \"quotes\"",
  "`a` `b` `c`",
  "[**b**](https://x.dev)",
  "**中文加粗** 和 ~~删除线~~",
  "*",
  "****",
  "[no url]()",
];

for (const s of INLINE_CORPUS) {
  test(`inline parity: ${JSON.stringify(s)}`, () => {
    expect(renderInline(s)).toBe(inlineOracle(s));
  });
}
