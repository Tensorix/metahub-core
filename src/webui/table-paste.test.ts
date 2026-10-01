import { describe, expect, test } from "bun:test";
import { parseGrid, pasteValueFor, pastePatches } from "./table-paste.ts";
import type { Prop } from "./api.ts";

const prop = (type: Prop["type"], options?: string[]): Prop =>
  ({ id: `p_${type}`, database_id: "db", name: type, type, config: options ? { options } : null, position: 1 }) as unknown as Prop;

describe("parseGrid", () => {
  test("tabs and newlines", () => {
    expect(parseGrid("a\tb\nc\td\n")).toEqual([["a", "b"], ["c", "d"]]);
  });
  test("CRLF", () => {
    expect(parseGrid("a\tb\r\nc\td")).toEqual([["a", "b"], ["c", "d"]]);
  });
  test("quoted cell with newline and escaped quote", () => {
    expect(parseGrid('"line 1\nline 2"\t"say ""hi"""\nx\ty')).toEqual([["line 1\nline 2", 'say "hi"'], ["x", "y"]]);
  });
  test("single value", () => {
    expect(parseGrid("hello")).toEqual([["hello"]]);
  });
  test("empty cells survive", () => {
    expect(parseGrid("\t\n\tz")).toEqual([["", ""], ["", "z"]]);
  });
});

describe("pasteValueFor", () => {
  test("number", () => {
    expect(pasteValueFor(prop("number"), "1,234.5")).toEqual({ ok: true, value: 1234.5 });
    expect(pasteValueFor(prop("number"), "")).toEqual({ ok: true, value: null });
    expect(pasteValueFor(prop("number"), "abc")).toEqual({ ok: false });
  });
  test("checkbox", () => {
    expect(pasteValueFor(prop("checkbox"), "是")).toEqual({ ok: true, value: true });
    expect(pasteValueFor(prop("checkbox"), "")).toEqual({ ok: true, value: false });
    expect(pasteValueFor(prop("checkbox"), "maybe")).toEqual({ ok: false });
  });
  test("date", () => {
    expect(pasteValueFor(prop("date"), "2026-03-04")).toEqual({ ok: true, value: "2026-03-04" });
    expect(pasteValueFor(prop("date"), "nope")).toEqual({ ok: false });
  });
  test("select matches case-insensitively and rejects unknown", () => {
    const p = prop("select", ["Backlog", "Shipped"]);
    expect(pasteValueFor(p, "shipped")).toEqual({ ok: true, value: "Shipped" });
    expect(pasteValueFor(p, "Nope")).toEqual({ ok: false });
    expect(pasteValueFor(p, "")).toEqual({ ok: true, value: null });
  });
  test("multi_select splits and keeps known options", () => {
    const p = prop("multi_select", ["core", "webui", "sync"]);
    expect(pasteValueFor(p, "core, webui, bogus")).toEqual({ ok: true, value: ["core", "webui"] });
    expect(pasteValueFor(p, "bogus")).toEqual({ ok: false });
    expect(pasteValueFor(p, "")).toEqual({ ok: true, value: [] });
  });
  test("relation and doc are never pasted", () => {
    expect(pasteValueFor(prop("relation"), "x")).toEqual({ ok: false });
    expect(pasteValueFor(prop("doc"), "x")).toEqual({ ok: false });
  });
});

describe("pastePatches", () => {
  const props = [prop("text"), prop("number"), prop("select", ["A", "B"])];
  const rows = [
    { id: "r1", cells: { p_text: "old", p_number: 1, p_select: "A" } },
    { id: "r2", cells: {} },
  ];
  test("clips to the table and skips unchanged cells", () => {
    const { patches, skipped } = pastePatches([["old", "2", "B"], ["x", "y", "C"], ["z"]], rows, props, 0, 0);
    expect(skipped).toBe(2);
    expect(patches).toEqual([
      { recId: "r1", propId: "p_number", value: 2 },
      { recId: "r1", propId: "p_select", value: "B" },
      { recId: "r2", propId: "p_text", value: "x" },
    ]);
  });
  test("offset start", () => {
    const { patches } = pastePatches([["5"]], rows, props, 1, 1);
    expect(patches).toEqual([{ recId: "r2", propId: "p_number", value: 5 }]);
  });
});
