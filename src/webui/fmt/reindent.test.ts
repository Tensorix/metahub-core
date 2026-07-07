// Bracket-depth reindent (fmt/reindent.ts): the 格式化 fallback for brace
// languages without a real engine. Only leading whitespace may change; the
// scanner must not count brackets inside strings or comments.
import { test, expect } from "bun:test";
import { reindent } from "./reindent";

test("normalizes messy indentation by bracket depth", () => {
  const src = [
    "fn main() {",
    "let x = 1;",
    "      if x > 0 {",
    "  println!(\"hi\");",
    "        }",
    "}",
  ].join("\n");
  expect(reindent(src, "rust")).toBe([
    "fn main() {",
    "  let x = 1;",
    "  if x > 0 {",
    "    println!(\"hi\");",
    "  }",
    "}",
  ].join("\n"));
});

test("already-normalized input returns null (no-op contract)", () => {
  const src = "fn f() {\n  g();\n}";
  expect(reindent(src, "rust")).toBeNull();
});

test("brackets inside strings do not affect depth", () => {
  const src = "let s = \"{[(\";\nlet t = 1;";
  expect(reindent(src, "rust")).toBeNull();
});

test("brackets inside line comments do not affect depth", () => {
  const src = "let a = 1; // {{{\nlet b = 2;";
  expect(reindent(src, "rust")).toBeNull();
});

test("brackets inside block comments do not affect depth", () => {
  const src = "/* { */\nlet a = 1;\n/*\n  {{\n*/\nlet b = 2;";
  expect(reindent(src, "rust")).toBeNull();
});

test("block comment continuation lines keep their own leading whitespace", () => {
  // The /* opener sits at a code position and gets indented; the continuation
  // and the closing line are comment content and stay untouched.
  const src = "f({\n/*\n   aligned art {\n*/\ng();\n});";
  expect(reindent(src, "rust")).toBe("f({\n  /*\n   aligned art {\n*/\n  g();\n});");
});

test("multiple leading closers dedent by their count", () => {
  const src = "a({\nb({\nc();\n})});";
  // line 4 starts with three closers → depth 4 - 3 … clamped per leading run
  const out = reindent(src, "swift")!;
  expect(out.split("\n")[2]).toBe("    c();");
  expect(out.split("\n")[3]).toBe("})});");
});

test("hash comments for perl", () => {
  const src = "sub f { # {{{\nmy $x = 1;\n}";
  expect(reindent(src, "perl")).toBe("sub f { # {{{\n  my $x = 1;\n}");
});

test("blank lines stay empty with no trailing whitespace", () => {
  const src = "f({\n\ng();\n});";
  expect(reindent(src, "kotlin")).toBe("f({\n\n  g();\n});");
});

test("template literal spanning lines is left untouched", () => {
  const src = "let s = `\n   raw { content\n`;\nlet x = 1;";
  expect(reindent(src, "rust")).toBeNull();
});

test("depth never goes negative on unbalanced closers", () => {
  const src = "}\n}\ncode();";
  expect(reindent(src, "rust")).toBeNull();
});
