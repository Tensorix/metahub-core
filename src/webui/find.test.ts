import { test, expect } from "bun:test";
import { findInText } from "./find.ts";

const opts = (o: Partial<{ caseSensitive: boolean; wholeWord: boolean }> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  ...o,
});

test("findInText: case-insensitive substring (default)", () => {
  expect(findInText("Foo foo FOO", "foo", opts())).toEqual([
    [0, 3],
    [4, 7],
    [8, 11],
  ]);
});

test("findInText: case-sensitive only matches exact case", () => {
  expect(findInText("Foo foo FOO", "foo", opts({ caseSensitive: true }))).toEqual([[4, 7]]);
});

test("findInText: empty term yields nothing", () => {
  expect(findInText("anything", "", opts())).toEqual([]);
});

test("findInText: overlapping advances past each match", () => {
  expect(findInText("aaaa", "aa", opts())).toEqual([
    [0, 2],
    [2, 4],
  ]);
});

test("findInText: whole-word constrains ASCII word edges", () => {
  // "cat" matches the standalone word but not inside "category" / "scat".
  expect(findInText("cat category scat cat.", "cat", opts({ wholeWord: true }))).toEqual([
    [0, 3],
    [18, 21],
  ]);
});

test("findInText: whole-word degrades to substring for CJK (no word boundaries)", () => {
  // 文档 has no ASCII word boundary, so 全词 still finds it inside 本文档好.
  expect(findInText("本文档好 文档", "文档", opts({ wholeWord: true }))).toEqual([
    [1, 3],
    [5, 7],
  ]);
});
