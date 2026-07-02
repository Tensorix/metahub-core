import { test, expect } from "bun:test";
import { inlineToHtml, escapeHtml } from "./markdown.tsx";

test("escapeHtml neutralises markup", () => {
  expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("inlineToHtml renders bold, italic, code and links", () => {
  expect(inlineToHtml("**bold**")).toBe("<strong>bold</strong>");
  expect(inlineToHtml("a *it* b")).toBe("a <em>it</em> b");
  expect(inlineToHtml("`x<y`")).toBe("<code>x&lt;y</code>");
  expect(inlineToHtml("[t](http://e.com)")).toBe(
    '<a href="http://e.com" target="_blank" rel="noreferrer">t</a>',
  );
});

test("code spans are opaque to other inline rules", () => {
  // the * inside the code span must not become italic
  expect(inlineToHtml("`a*b*c`")).toBe("<code>a*b*c</code>");
});

test("plain text is escaped", () => {
  expect(inlineToHtml("1 < 2 & 3")).toBe("1 &lt; 2 &amp; 3");
});

test("renders a doc image as <img class=doc-img>", () => {
  const html = inlineToHtml("![cat](/blob/abc123def456.png)");
  expect(html).toContain('<img src="/blob/abc123def456.png"');
  expect(html).toContain('alt="cat"');
  expect(html).toContain('class="doc-img"');
});

test("the image rule does not swallow a following link", () => {
  const html = inlineToHtml("![a](/blob/x.png) see [docs](http://e.com)");
  expect(html).toContain("<img");
  expect(html).toContain('<a href="http://e.com"');
});

test("a plain link still renders and is not turned into an image", () => {
  const html = inlineToHtml("[docs](http://x)");
  expect(html).toContain('<a href="http://x"');
  expect(html).not.toContain("<img");
});

// --- unified grammar (shared tokenizer) additions ---

test("underscore and tilde variants render like the editor shows them", () => {
  expect(inlineToHtml("__bold__")).toBe("<strong>bold</strong>");
  expect(inlineToHtml("a _it_ b")).toBe("a <em>it</em> b");
  expect(inlineToHtml("~~gone~~")).toBe("<del>gone</del>");
});

test("escaped delimiters stay literal text (backslash kept, v1)", () => {
  expect(inlineToHtml("\\*not em\\*")).toBe("\\*not em\\*");
  expect(inlineToHtml("\\`not code`")).toBe("\\`not code`");
  expect(inlineToHtml("\\~~not del~~")).toBe("\\~~not del~~");
});

test("word-internal underscores are not emphasis", () => {
  expect(inlineToHtml("snake_case_name")).toBe("snake_case_name");
});
