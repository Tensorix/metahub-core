import { test, expect } from "bun:test";
import { toCsv, parseCsv } from "./csv.ts";

test("encodes only cells that need quoting", () => {
  expect(toCsv([["a", "b", "c"]])).toBe("a,b,c");
  expect(toCsv([["a,b", 'has "q"', "line\nbreak"]])).toBe('"a,b","has ""q""","line\nbreak"');
});

test("round-trips commas, quotes, and newlines", () => {
  const grid = [
    ["id", "title", "note"],
    ["1", "Hello, world", 'She said "hi"'],
    ["2", "multi\nline", "plain"],
    ["3", "", "trailing,comma,"],
  ];
  expect(parseCsv(toCsv(grid))).toEqual(grid);
});

test("tolerates trailing newline and CRLF", () => {
  expect(parseCsv("a,b\r\nc,d\n")).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("empty input yields no rows", () => {
  expect(parseCsv("")).toEqual([]);
});

test("preserves empty fields", () => {
  expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
});
