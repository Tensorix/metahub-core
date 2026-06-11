import { test, expect } from "bun:test";
import { htmlToMarkdown } from "./html-md.ts";
import { blocksFromBody } from "./blocks.ts";

test("headings h1-h6 -> atx", () => {
  const md = htmlToMarkdown("<h1>A</h1><h2>B</h2><h4>C</h4>");
  expect(md).toContain("# A");
  expect(md).toContain("## B");
  expect(md).toContain("#### C");
});

test("fenced code keeps language from class", () => {
  const md = htmlToMarkdown('<pre><code class="language-ts">const x = 1;</code></pre>');
  expect(md).toContain("```ts");
  expect(md).toContain("const x = 1;");
  const blocks = blocksFromBody(md);
  expect(blocks.some((b) => b.type === "code" && b.lang === "ts")).toBe(true);
});

test("code block with ChatGPT-style toolbar header is not folded in", () => {
  // ChatGPT wraps the snippet in a <pre> that also holds a label + copy button.
  const html =
    '<pre><div class="header"><span>javascript</span><button>Copy code</button></div>' +
    '<code class="language-javascript">const a = 1;\nconst b = 2;</code></pre>';
  const md = htmlToMarkdown(html);
  expect(md).toContain("```javascript");
  expect(md).not.toContain("Copy code");
  const blocks = blocksFromBody(md);
  const code = blocks.find((b) => b.type === "code");
  expect(code?.content).toBe("const a = 1;\nconst b = 2;");
  expect(code?.lang).toBe("javascript");
});

test("ordered and unordered lists", () => {
  const md = htmlToMarkdown("<ol><li>one</li><li>two</li></ol><ul><li>a</li><li>b</li></ul>");
  const blocks = blocksFromBody(md);
  expect(blocks.some((b) => b.type === "numbered")).toBe(true);
  expect(blocks.some((b) => b.type === "bullet")).toBe(true);
});

test("blockquote -> quote block", () => {
  const md = htmlToMarkdown("<blockquote><p>quoted line</p></blockquote>");
  const blocks = blocksFromBody(md);
  expect(blocks.some((b) => b.type === "quote" && b.content.includes("quoted line"))).toBe(true);
});

test("inline strong/em/code/link survive as markdown", () => {
  const md = htmlToMarkdown('<p>see <strong>bold</strong> <em>it</em> <code>x</code> <a href="https://e.com">link</a></p>');
  expect(md).toContain("**bold**");
  expect(md).toContain("*it*");
  expect(md).toContain("`x`");
  expect(md).toContain("[link](https://e.com)");
});

test("literal markdown punctuation is not backslash-escaped", () => {
  // The editor's parser has no concept of backslash escapes, so escaping would
  // surface as literal "\`" in the document. The HTML flavor must behave like
  // the text/plain paste path: leave the characters bare.
  expect(htmlToMarkdown("<div>``` 代码块 连续两次回车</div>")).toBe("``` 代码块 连续两次回车");
  expect(htmlToMarkdown("<p>1. foo *bar* _baz_</p>")).toBe("1. foo *bar* _baz_");
  // …and the bare ``` line pastes as prose (unclosed fence), not a code block.
  expect(blocksFromBody(htmlToMarkdown("<div>```p111</div>"))).toMatchObject([{ type: "p", content: "```p111" }]);
});

test("Cocoa clipboard <style> header is dropped, not pasted as prose", () => {
  // macOS native text fields put a styled HTML flavor on the clipboard.
  const html =
    '<html><head><meta charset="utf-8"><style type="text/css">' +
    "p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 26.0px '.SF NS'; color: #000000}" +
    '</style></head><body><p class="p1">```p111</p></body></html>';
  expect(htmlToMarkdown(html)).toBe("```p111");
});

test("mixed ChatGPT-style answer round-trips into structured blocks", () => {
  const html =
    "<p>可以，但分两档：</p>" +
    "<ol><li>原生侧边栏：可以。</li></ol>" +
    '<pre><code class="language-ts">const win = new BrowserWindow({});</code></pre>' +
    "<p>结论：用 Electron。</p>";
  const blocks = blocksFromBody(htmlToMarkdown(html));
  const types = blocks.map((b) => b.type);
  expect(types).toContain("numbered");
  expect(types).toContain("code");
  expect(blocks.filter((b) => b.type === "code")[0]?.content).toContain("BrowserWindow");
});
