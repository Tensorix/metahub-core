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
