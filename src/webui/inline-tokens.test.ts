// Grammar pins for the shared inline tokenizer. Every rendering surface
// (cm6/inline.ts decorations, markdown.tsx inlineToHtml, toc.tsx labels)
// consumes tokenizeInline, so these tests are the single drift alarm for the
// inline grammar: kinds, positions, priority, escapes, and the deliberate
// single-level (no nesting) semantics.

import { test, expect } from "bun:test";
import { tokenizeInline, stripInlineTokens, type InlineToken } from "./inline-tokens";

const kinds = (s: string) => tokenizeInline(s).map((t) => t.kind);
const inner = (s: string, t: InlineToken) => s.slice(t.innerFrom, t.innerTo);

// --- each kind on its own -------------------------------------------------

test("code span", () => {
  const s = "a `x<y` b";
  const [t] = tokenizeInline(s);
  expect(t).toMatchObject({ kind: "code", start: 2, end: 7, innerFrom: 3, innerTo: 6 });
  expect(inner(s, t!)).toBe("x<y");
});

test("strong: ** and __ both tokenize", () => {
  const s = "**a**";
  expect(tokenizeInline(s)[0]).toMatchObject({ kind: "strong", start: 0, end: 5, innerFrom: 2, innerTo: 3 });
  const u = "__b__";
  expect(tokenizeInline(u)[0]).toMatchObject({ kind: "strong", start: 0, end: 5 });
  expect(inner(u, tokenizeInline(u)[0]!)).toBe("b");
});

test("em: * and _ both tokenize, with boundary guards", () => {
  expect(tokenizeInline("say *hi* now")[0]).toMatchObject({ kind: "em", start: 4, end: 8, innerFrom: 5, innerTo: 7 });
  expect(tokenizeInline("say _hi_ now")[0]).toMatchObject({ kind: "em", start: 4, end: 8 });
  // word-adjacent delimiters do not open (inherited from the CM6 grammar)
  expect(kinds("snake_case_name")).toEqual([]);
  expect(kinds("a*b*c")).toEqual([]);
});

test("del", () => {
  const s = "x ~~gone~~ y";
  expect(tokenizeInline(s)[0]).toMatchObject({ kind: "del", start: 2, end: 10, innerFrom: 4, innerTo: 8 });
});

test("link carries url, inner is the text", () => {
  const s = "see [docs](https://e.com) here";
  const [t] = tokenizeInline(s);
  expect(t).toMatchObject({ kind: "link", start: 4, end: 25, innerFrom: 5, innerTo: 9, url: "https://e.com" });
  expect(inner(s, t!)).toBe("docs");
});

test("image carries url and alt, inner is the alt", () => {
  const s = "pic ![cat](/blob/a.png) end";
  const [t] = tokenizeInline(s);
  expect(t).toMatchObject({ kind: "image", start: 4, end: 23, url: "/blob/a.png", alt: "cat" });
  expect(inner(s, t!)).toBe("cat");
});

test("image with empty alt still tokenizes (inner is empty)", () => {
  const [t] = tokenizeInline("![](/blob/x.png)");
  expect(t).toMatchObject({ kind: "image", start: 0, end: 16, innerFrom: 2, innerTo: 2, alt: "" });
});

test("doclink: bare id, inner is the id", () => {
  const s = "see [[doc_notes-abc123]] here";
  const [t] = tokenizeInline(s);
  expect(t).toMatchObject({ kind: "doclink", start: 4, end: 24, id: "doc_notes-abc123" });
  expect(inner(s, t!)).toBe("doc_notes-abc123");
  expect(t!.alias).toBeUndefined();
});

test("doclink: alias form, inner is the alias", () => {
  const s = "[[db_tasks-7q1zzb|任务表]]";
  const [t] = tokenizeInline(s);
  expect(t).toMatchObject({ kind: "doclink", start: 0, end: s.length, id: "db_tasks-7q1zzb", alias: "任务表" });
  expect(inner(s, t!)).toBe("任务表");
});

test("doclink: only id-shaped doc/db targets tokenize", () => {
  expect(kinds("[[not an id]]")).toEqual([]);
  expect(kinds("[[doc notes]]")).toEqual([]);
  expect(kinds("[[site_blog-a0b1c2]]")).toEqual([]); // no route for sites in docs
  expect(kinds("[[Doc_Upper-abc123]]")).toEqual([]);
  expect(kinds("\\[[doc_escaped-abc123]]")).toEqual([]);
});

test("doclink outranks link; trailing (x) stays literal", () => {
  const s = "[[doc_a1]](tail)";
  const tokens = tokenizeInline(s);
  expect(tokens.map((t) => t.kind)).toEqual(["doclink"]);
  expect(tokens[0]!.end).toBe(10);
});

// --- full-line mixed tokenization ------------------------------------------

test("full line: every kind side by side, non-overlapping and sorted", () => {
  const s = "**a** __b__ _c_ ~~d~~ \\*e\\* ![i](/x.png) [l](https://x)";
  const tokens = tokenizeInline(s);
  expect(tokens.map((t) => t.kind)).toEqual(["strong", "strong", "em", "del", "image", "link"]);
  expect(tokens.map((t) => [t.start, t.end])).toEqual([
    [0, 5],
    [6, 11],
    [12, 15],
    [16, 21],
    [28, 40],
    [41, 55],
  ]);
  expect(tokens.map((t) => inner(s, t))).toEqual(["a", "b", "c", "d", "i", "l"]);
  // the escaped \*e\* (indices 22..26) produced no token at all
  for (const t of tokens) {
    expect(t.end <= 22 || t.start >= 27).toBe(true);
  }
  // sorted + non-overlapping invariant
  for (let i = 1; i < tokens.length; i++) expect(tokens[i]!.start >= tokens[i - 1]!.end).toBe(true);
});

// --- escapes ----------------------------------------------------------------

test("escaped delimiters do not open or close tokens", () => {
  expect(kinds("\\*not em\\*")).toEqual([]);
  expect(kinds("\\**still not**")).not.toContain("strong"); // \* kills the opener
  expect(kinds("\\`not code`")).toEqual([]);
  expect(kinds("\\~~not del~~")).toEqual([]);
  expect(kinds("\\__not strong__")).toEqual([]);
  expect(kinds("\\[not](a-link)")).toEqual([]);
});

test("escaped closer keeps the span unclosed", () => {
  expect(kinds("*a\\*")).toEqual([]);
  expect(kinds("**a\\**")).toEqual([]);
});

test("escaped ! yields a link, not an image", () => {
  const s = "\\![alt](/u.png)";
  const tokens = tokenizeInline(s);
  expect(tokens.map((t) => t.kind)).toEqual(["link"]);
  expect(tokens[0]!.url).toBe("/u.png");
});

// --- priority / overlap ------------------------------------------------------

test("image outranks link: ![a](u) is one image token, no bare-! link", () => {
  const tokens = tokenizeInline("![a](/u.png)");
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.kind).toBe("image");
  expect(tokens[0]!.start).toBe(0); // starts at the !, not the [
});

test("code swallows other delimiters", () => {
  const s = "`**x**`";
  const tokens = tokenizeInline(s);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.kind).toBe("code");
  expect(inner(s, tokens[0]!)).toBe("**x**");
});

test("earlier token wins overlaps (greedy left-to-right)", () => {
  // the code span opens first and consumes through the second backtick,
  // so the ** pair inside never becomes strong
  expect(kinds("a `code **not bold` still**")).toEqual(["code"]);
});

// --- nesting (single-level, documented behavior) -----------------------------

test("no nesting: `**a *b* c**` yields only the inner em (strong content cannot cross the single *)", () => {
  const s = "**a *b* c**";
  const tokens = tokenizeInline(s);
  expect(tokens.map((t) => t.kind)).toEqual(["em"]);
  expect(inner(s, tokens[0]!)).toBe("b");
});

test("no nesting: link text with strong inside stays a single link token", () => {
  const s = "[**b**](https://e.com)";
  const tokens = tokenizeInline(s);
  expect(tokens.map((t) => t.kind)).toEqual(["link"]);
  expect(inner(s, tokens[0]!)).toBe("**b**");
});

// --- degenerate inputs --------------------------------------------------------

test("plain / empty / marker-less lines yield no tokens", () => {
  expect(tokenizeInline("")).toEqual([]);
  expect(tokenizeInline("just plain text")).toEqual([]);
  expect(tokenizeInline("lonely * star and _ under")).toEqual([]);
  expect(tokenizeInline("**")).toEqual([]); // empty content never tokenizes
  expect(tokenizeInline("****")).toEqual([]);
});

test("urls with whitespace are not link/image targets", () => {
  expect(kinds("[a](u v)")).toEqual([]);
  expect(kinds("![a](u v)")).toEqual([]);
});

// --- stripInlineTokens ---------------------------------------------------------

test("stripInlineTokens flattens every kind to plain text", () => {
  expect(stripInlineTokens("**a** `b` ~~c~~ _d_ [e](u) ![f](/g.png)")).toBe("a b c d e f");
});

test("stripInlineTokens flattens doclinks to alias/id", () => {
  expect(stripInlineTokens("[[doc_notes-abc123]]")).toBe("doc_notes-abc123");
  expect(stripInlineTokens("[[doc_notes-abc123|我的笔记]]")).toBe("我的笔记");
});

test("stripInlineTokens runs to a fixed point on nested syntax", () => {
  expect(stripInlineTokens("[**b**](https://e.com)")).toBe("b");
});

test("stripInlineTokens leaves escapes and plain text untouched", () => {
  expect(stripInlineTokens("\\*e\\* plain")).toBe("\\*e\\* plain");
});
