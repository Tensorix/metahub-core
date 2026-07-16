// Smoke tests through the real "core" provider bundle entry (prettier
// standalone + plugins + sql-formatter under bun). Slowish (~1s to load the
// engines) but this is the only automated coverage that the plugin wiring,
// parser table and cursor plumbing actually work before a browser ever loads
// the lazy asset.
import { test, expect } from "bun:test";
import { format } from "./fmt-core";

test("javascript: splits a one-liner and tracks the cursor", async () => {
  const r = await format("const a={b:1,c:[2,3]};if(a.b){foo( a,1 )}", "javascript", 9);
  expect(r.text).toBe("const a = { b: 1, c: [2, 3] };\nif (a.b) {\n  foo(a, 1);\n}\n");
  // cursor was after "={b" → lands somewhere inside the object literal
  expect(r.text.slice(r.cursor - 1, r.cursor + 1)).toContain("b");
});

test("typescript via babel-ts: types and generics survive", async () => {
  const r = await format("function f<T>(x:T):Map<string,T>{return new Map([['a',x]])}", "ts", 0);
  expect(r.text).toBe(
    "function f<T>(x: T): Map<string, T> {\n  return new Map([[\"a\", x]]);\n}\n",
  );
});

test("css and scss", async () => {
  expect((await format(".a{color:red;margin:0}", "css", 0)).text)
    .toBe(".a {\n  color: red;\n  margin: 0;\n}\n");
  expect((await format("$x:1px;.a{.b{margin:$x}}", "scss", 0)).text)
    .toBe("$x: 1px;\n.a {\n  .b {\n    margin: $x;\n  }\n}\n");
});

test("html via the xml lang id", async () => {
  const r = await format("<div><span >a</span ></div>", "xml", 0);
  expect(r.text).toBe("<div><span>a</span></div>\n");
});

test("yaml", async () => {
  const r = await format("a:   1\nb:\n -  x\n -  y", "yaml", 0);
  expect(r.text).toBe("a: 1\nb:\n  - x\n  - y\n");
});

test("php", async () => {
  const r = await format("<?php function f( $a ){ return $a+1; }", "php", 0);
  expect(r.text).toContain("function f($a)");
  expect(r.text).toContain("return $a + 1;");
});

test("sql keeps the cursor (clamped by the dispatcher, not here)", async () => {
  const r = await format("select a,b from t where x=1", "sql", 3);
  expect(r.text).toBe("select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1");
  expect(r.cursor).toBe(3);
});

test("jsonc: comments survive, formatting applies", async () => {
  const r = await format('{// c\n"a":1,"b":[2,3]}', "jsonc", 0);
  expect(r.text).toContain("// c");
  expect(r.text).toContain('"a": 1');
});

test("json5: single quotes / unquoted keys / trailing comma format (no strict-JSON error)", async () => {
  const r = await format("{a:1,b:'x',}", "json5", 0);
  expect(r.text).toContain("a: 1"); // unquoted keys survive
  expect(r.text).toContain("b:"); // formats instead of throwing on the dialect
});

test("syntax errors reject with a line-referencing message", async () => {
  await expect(format("const = ;", "javascript", 0)).rejects.toThrow(/\(1:7\)|Unexpected/);
});

test("unknown language rejects", async () => {
  await expect(format("x", "brainfuck", 0)).rejects.toThrow(/不支持/);
});
