import { test, expect } from "bun:test";
import { countSource, countText } from "./wordcount";

test("empty document counts to zero", () => {
  expect(countSource("")).toEqual({ zi: 0, chars: 0, minutes: 0 });
});

test("pure CJK counts per glyph", () => {
  const s = countSource("你好世界");
  expect(s.zi).toBe(4);
  expect(s.chars).toBe(4);
  expect(s.minutes).toBe(1);
});

test("mixed CJK + Latin: glyphs per char, Latin per word", () => {
  // 3 CJK + "hello" + "world" (2 words) = 5
  const s = countSource("你好吗 hello world");
  expect(s.zi).toBe(5);
});

test("Latin contractions and hyphens stay one word", () => {
  expect(countSource("can't stop").zi).toBe(2);
  expect(countSource("state-of-the-art").zi).toBe(1);
});

test("numbers count as words", () => {
  expect(countSource("version 2 point 0").zi).toBe(4);
});

test("heading and list markers are not counted", () => {
  expect(countSource("# Title").zi).toBe(1); // "Title" only, not the "#"
  expect(countSource("- one two").zi).toBe(2); // marker dropped
  expect(countSource("1. alpha beta").zi).toBe(2);
  expect(countSource("- [ ] task here").zi).toBe(2);
  expect(countSource("> quoted words here").zi).toBe(3);
});

test("links count their label, inline images their alt, not the URL", () => {
  // "see" + "docs" = 2 (the long URL is not counted)
  expect(countSource("see [docs](https://example.com/a/b/c)").zi).toBe(2);
  // an image *inline* in a paragraph stays prose: alt "diagram" counts, URL does not
  expect(countSource("see ![diagram](https://example.com/x.png) here").zi).toBe(3);
});

test("emphasis markers are stripped, inner text counted once", () => {
  expect(countSource("**bold** and *italic*").zi).toBe(3); // bold, and, italic
});

test("code fences excluded, code interior counted literally", () => {
  const src = "```js\nconst x = 1\n```";
  const s = countSource(src);
  // fence lines (``` / ```) not counted; "const", "x", "1" are (=3)
  expect(s.zi).toBe(3);
});

test("table pipes and alignment row excluded, cells counted", () => {
  const src = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
  const s = countSource(src);
  // header cells: Name, Age; body cells: Alice, 30 → 4 words. Alignment row skipped.
  expect(s.zi).toBe(4);
});

test("media embeds contribute nothing", () => {
  // A bare video embed is a void; its URL is not prose.
  expect(countSource("![](https://example.com/clip.mp4)").zi).toBe(0);
  // A standalone image line is promoted to an image void → skipped entirely.
  expect(countSource("![diagram](https://example.com/x.png)").zi).toBe(0);
});

test("blank lines and dividers are skipped", () => {
  const src = "one\n\n---\n\ntwo";
  expect(countSource(src).zi).toBe(2);
});

test("reading time splits CJK and Latin speeds", () => {
  const cjk = "字".repeat(800); // 800 / 400 = 2 min
  expect(countSource(cjk).minutes).toBe(2);
  const latin = Array.from({ length: 400 }, () => "word").join(" "); // 400 / 200 = 2 min
  expect(countSource(latin).minutes).toBe(2);
});

test("countText tallies a bare fragment with inline stripping", () => {
  expect(countText("hello 世界").zi).toBe(3); // "hello" (1 word) + 世 + 界 (2 glyphs)
  expect(countText("[label](url)").zi).toBe(1); // label only
});

test("chars is non-whitespace code points", () => {
  const s = countSource("ab cd\nef");
  expect(s.chars).toBe(6); // a b c d e f, whitespace excluded
});
