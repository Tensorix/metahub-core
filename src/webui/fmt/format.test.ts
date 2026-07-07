// The 格式化 dispatcher's inline engines and helpers (fmt/format.ts): native
// JSON formatting with the tolerant trailing-comma pre-pass, cursor mapping
// for line-preserving rewrites, and the unchanged→null / trailing-newline
// contracts. Lazy providers are exercised by their own smoke tests.
import { test, expect } from "bun:test";
import { formatCode, formatJson, mapCursor, stripTrailingCommas } from "./format";

// ---- stripTrailingCommas ----

test("drops trailing commas before } and ]", () => {
  expect(stripTrailingCommas('{"a": 1,}')).toBe('{"a": 1}');
  expect(stripTrailingCommas('[1, 2,\n]')).toBe("[1, 2\n]");
});

test("keeps commas inside strings", () => {
  expect(stripTrailingCommas('{"a": ",}", "b": 1}')).toBe('{"a": ",}", "b": 1}');
  expect(stripTrailingCommas('{"a": "x,", "b": "\\",}"}')).toBe('{"a": "x,", "b": "\\",}"}');
});

// ---- formatJson ----

test("expands single-line JSON", () => {
  expect(formatJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
});

test("tolerates trailing commas", () => {
  expect(formatJson('{"a": 1,}')).toBe('{\n  "a": 1\n}');
});

test("throws a labeled error on invalid JSON", () => {
  expect(() => formatJson("{a: 1}")).toThrow(/JSON 解析失败/);
});

// ---- mapCursor ----

test("same-line-count rewrite maps cursor by line + content column", () => {
  const oldText = "f({\ng();\n});";
  const newText = "f({\n  g();\n});";
  // cursor after "g" on line 2 (index 4+1=5) → line 2 col 1 → 4 + 2ws + 1 = 7
  expect(mapCursor(oldText, newText, 5)).toBe(7);
});

test("line-count change falls back to clamping", () => {
  expect(mapCursor("ab", "a\nb", 2)).toBe(2);
  expect(mapCursor("a\nb", "ab", 3)).toBe(2);
});

// ---- formatCode (inline engines) ----

test("json engine formats and clamps the cursor", async () => {
  const r = await formatCode('{"a":1}', "json", 3);
  expect(r!.text).toBe('{\n  "a": 1\n}');
  expect(r!.cursor).toBeLessThanOrEqual(r!.text.length);
});

test("unknown language returns null (no button, no work)", async () => {
  expect(await formatCode("x=1", "brainfuck", 0)).toBeNull();
  expect(await formatCode("x=1", undefined, 0)).toBeNull();
  expect(await formatCode("x=1", "ruby", 0)).toBeNull();
});

test("reindent engine returns null when already formatted", async () => {
  expect(await formatCode("fn f() {\n  g();\n}", "rust", 0)).toBeNull();
});

test("reindent engine maps the cursor onto the same line", async () => {
  const r = await formatCode("f({\ng();\n});", "rust", 5);
  expect(r!.text).toBe("f({\n  g();\n});");
  expect(r!.cursor).toBe(7);
});

test("no trailing newline is introduced when the input has none", async () => {
  const r = await formatCode('{"a":1}', "json", 0);
  expect(r!.text.endsWith("\n")).toBe(false);
});
