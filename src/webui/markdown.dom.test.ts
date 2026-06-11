// htmlToInline needs a DOM (document.createElement); register happy-dom for
// this file only and unregister afterwards — bun test runs every file in one
// process, so a leaked global `document` would flip turndown (html-md.test.ts)
// from its bundled domino DOM onto happy-dom and break it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { htmlToInline, inlineToHtml } from "./markdown.tsx";

afterAll(() => GlobalRegistrator.unregister());

test("htmlToInline maps semantic and legacy tags to markdown", () => {
  expect(htmlToInline("<strong>b</strong>")).toBe("**b**");
  expect(htmlToInline("<b>b</b>")).toBe("**b**"); // execCommand's output
  expect(htmlToInline("<em>i</em>")).toBe("*i*");
  expect(htmlToInline("<i>i</i>")).toBe("*i*");
  expect(htmlToInline("<code>x</code>")).toBe("`x`");
  expect(htmlToInline('<a href="https://e.com">t</a>')).toBe("[t](https://e.com)");
});

test("NBSP from contentEditable normalizes to a plain space", () => {
  // Browsers serialize a trailing space as &nbsp; — it must not reach the
  // saved markdown (find/grep would miss it).
  expect(htmlToInline("foo&nbsp;")).toBe("foo ");
  expect(htmlToInline("a&nbsp;&nbsp;b")).toBe("a  b");
});

test("a trailing placeholder <br> is stripped, interior ones survive", () => {
  expect(htmlToInline("<br>")).toBe(""); // emptied line keeps a bogus <br>
  expect(htmlToInline("foo<br>")).toBe("foo");
  expect(htmlToInline("a<br>b")).toBe("a\nb"); // soft line break is content
});

test("inlineToHtml renders newlines as <br>, symmetric with htmlToInline", () => {
  expect(inlineToHtml("a\nb")).toBe("a<br>b");
  expect(htmlToInline(inlineToHtml("a\nb"))).toBe("a\nb");
});

test("round-trip is a fixed point for live-DOM states", () => {
  // The .editable renderKey effect skips the innerHTML rewrite when
  // htmlToInline(el.innerHTML) === block.content — these are the states the
  // semantic guard must recognize so the caret survives unrelated bumps.
  const cases = [
    "plain text",
    "**bold** and *it* and `code`",
    "literal *stars* typed as text",
    "[t](https://e.com) link",
    "line1\nline2",
    "trailing space ",
  ];
  for (const content of cases) {
    const div = document.createElement("div");
    div.innerHTML = inlineToHtml(content);
    expect(htmlToInline(div.innerHTML)).toBe(content);
  }
});
