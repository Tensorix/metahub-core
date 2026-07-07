// Engine-level smoke tests for the wasm/JS 格式化 providers, importing each
// package's node entry (self-initializes from the filesystem under bun). The
// browser glue modules (fmt-ruff.ts …) are one init(route) + one call on top
// of exactly these engines; their route wiring is covered by the build
// assertions (scripts/build.ts) and the binary smoke test (smoke-webui.ts).
import { test, expect } from "bun:test";
import { format as ruffFormat } from "@wasm-fmt/ruff_fmt";
import { format as goFormat } from "@wasm-fmt/gofmt";
import { format as clangFormat } from "@wasm-fmt/clang-format";
import { format as luaFormat } from "@wasm-fmt/lua_fmt";
import { format as taploFormat } from "@wasm-fmt/taplo_fmt";
import sh from "mvdan-sh";

test("ruff formats python (black style, 4-space)", () => {
  expect(ruffFormat("def foo (a,b):\n  return a+b", "block.py"))
    .toBe("def foo(a, b):\n    return a + b\n");
});

test("ruff rejects broken python", () => {
  expect(() => ruffFormat("def (:", "block.py")).toThrow();
});

test("gofmt formats go (tabs)", () => {
  expect(goFormat("package main\nfunc main(){x:=1\nprintln(x)}"))
    .toBe("package main\n\nfunc main() {\n\tx := 1\n\tprintln(x)\n}\n");
});

test("clang-format handles the whole C family via filenames", () => {
  expect(clangFormat("int main(){return 0;}", "block.c"))
    .toBe("int main() { return 0; }");
  expect(clangFormat("class A{public: int x;};", "block.cc")).toContain("class A {");
  expect(clangFormat("class A{void F(){int x=1;}}", "Block.java")).toContain("void F()");
});

test("stylua formats lua", () => {
  expect(luaFormat("local x=1\nif x then print( x ) end")).toContain("local x = 1");
});

test("taplo formats toml", () => {
  expect(taploFormat('a   =  1\n[b]\nc= "d"')).toBe('a = 1\n[b]\nc = "d"\n');
});

test("shfmt formats shell with 2-space indent and kept comments", () => {
  const { syntax } = sh;
  const parser = syntax.NewParser(syntax.KeepComments(true));
  const printer = syntax.NewPrinter(syntax.Indent(2));
  const out = printer.Print(parser.Parse("if true;   then\necho hi # note\nfi", "block.sh"));
  expect(out).toBe("if true; then\n  echo hi # note\nfi\n");
});

test("shfmt throws a parse error on broken shell", () => {
  const { syntax } = sh;
  const parser = syntax.NewParser();
  expect(() => parser.Parse("if true; then", "block.sh")).toThrow();
});
