// Tab indent / Shift+Tab outdent / Enter auto-indent computations for the code
// island textarea (media/code-edit.ts). Pure functions — apply the returned
// edit to the string here and assert both the text and the restored selection,
// since a wrong selection after indent is exactly the caret-jump bug class the
// island exists to avoid.
import { test, expect } from "bun:test";
import { tabEdit, newlineEdit, type TaEdit } from "./code-edit";

function apply(value: string, ed: TaEdit): { text: string; selStart: number; selEnd: number } {
  return {
    text: value.slice(0, ed.from) + ed.insert + value.slice(ed.to),
    selStart: ed.selStart,
    selEnd: ed.selEnd,
  };
}

// ---- Tab, no selection / single-line selection ----

test("Tab at a collapsed caret inserts two spaces", () => {
  const v = "abc";
  const r = apply(v, tabEdit(v, 1, 1, false)!);
  expect(r.text).toBe("a  bc");
  expect(r.selStart).toBe(3);
  expect(r.selEnd).toBe(3);
});

test("Tab over a single-line selection replaces it with the indent", () => {
  const v = "abcdef";
  const r = apply(v, tabEdit(v, 1, 4, false)!);
  expect(r.text).toBe("a  ef");
  expect(r.selStart).toBe(3);
  expect(r.selEnd).toBe(3);
});

// ---- Tab, multi-line selection ----

test("Tab over a multi-line selection indents every touched line", () => {
  const v = "aa\nbb\ncc";
  const r = apply(v, tabEdit(v, 1, 7, false)!);
  expect(r.text).toBe("  aa\n  bb\n  cc");
  // Selection keeps covering the same text: a|a … c|c → still inside all rows.
  expect(r.selStart).toBe(3);
  expect(r.selEnd).toBe(13);
});

test("multi-line Tab skips empty lines (no trailing whitespace)", () => {
  const v = "aa\n\nbb";
  const r = apply(v, tabEdit(v, 0, v.length, false)!);
  expect(r.text).toBe("  aa\n\n  bb");
});

test("selection ending at column 0 does not indent that line", () => {
  const v = "aa\nbb\ncc";
  const r = apply(v, tabEdit(v, 0, 6, false)!); // end sits right after "bb\n"
  expect(r.text).toBe("  aa\n  bb\ncc");
  expect(r.selEnd).toBe(10); // still at column 0 of "cc"
});

// ---- Shift+Tab ----

test("Shift+Tab on a collapsed caret outdents the current line", () => {
  const v = "    foo";
  const r = apply(v, tabEdit(v, 6, 6, true)!);
  expect(r.text).toBe("  foo");
  expect(r.selStart).toBe(4);
  expect(r.selEnd).toBe(4);
});

test("Shift+Tab removes at most two leading spaces per line", () => {
  const v = " a\n    b\nc";
  const r = apply(v, tabEdit(v, 0, v.length, true)!);
  expect(r.text).toBe("a\n  b\nc");
});

test("Shift+Tab leaves leading tabs alone (outdent only undoes our indent)", () => {
  const v = "\tfoo";
  expect(tabEdit(v, 2, 2, true)).toBeNull();
});

test("Shift+Tab is a no-op (null) when nothing can be removed", () => {
  expect(tabEdit("foo\nbar", 0, 7, true)).toBeNull();
});

test("Shift+Tab clamps a caret inside the removed indent to the line start", () => {
  const v = "aa\n  bb";
  const r = apply(v, tabEdit(v, 4, 4, true)!); // caret between the two spaces
  expect(r.text).toBe("aa\nbb");
  expect(r.selStart).toBe(3);
});

test("Shift+Tab keeps a multi-line selection on the same text", () => {
  const v = "  aa\n  bb";
  const r = apply(v, tabEdit(v, 3, 8, true)!); // "a … b" selected
  expect(r.text).toBe("aa\nbb");
  expect(r.selStart).toBe(1);
  expect(r.selEnd).toBe(4);
});

// ---- Enter auto-indent ----

test("Enter inherits the current line's leading spaces", () => {
  const v = "    foo";
  const r = apply(v, newlineEdit(v, 7, 7));
  expect(r.text).toBe("    foo\n    ");
  expect(r.selStart).toBe(12);
});

test("Enter inherits tabs verbatim", () => {
  const v = "\t\tfoo";
  const r = apply(v, newlineEdit(v, 5, 5));
  expect(r.text).toBe("\t\tfoo\n\t\t");
});

test("Enter mid-indent inherits only the whitespace before the caret", () => {
  const v = "    foo";
  const r = apply(v, newlineEdit(v, 2, 2));
  // The remainder keeps its own two spaces, so the moved line lands at the
  // original four columns with the caret at the inherited two.
  expect(r.text).toBe("  \n    foo");
  expect(r.selStart).toBe(5);
});

test("Enter after an opening bracket adds one extra level", () => {
  for (const [line, indent] of [
    ["  if (x) {", "    "],
    ["  foo(", "    "],
    ["  arr = [", "    "],
    ["  case 1:", "    "],
  ] as const) {
    const r = apply(line, newlineEdit(line, line.length, line.length));
    expect(r.text).toBe(line + "\n" + indent);
  }
});

test("Enter after a bracket followed by trailing spaces still adds a level", () => {
  const v = "if (x) {  ";
  const r = apply(v, newlineEdit(v, v.length, v.length));
  expect(r.text).toBe("if (x) {  \n  ");
});

test("Enter replaces an active selection with the indented newline", () => {
  const v = "  aXXXb";
  const r = apply(v, newlineEdit(v, 3, 6));
  expect(r.text).toBe("  a\n  b");
  expect(r.selStart).toBe(6);
  expect(r.selEnd).toBe(6);
});

test("Enter on a flush-left line inserts a bare newline", () => {
  const v = "foo";
  const r = apply(v, newlineEdit(v, 3, 3));
  expect(r.text).toBe("foo\n");
  expect(r.selStart).toBe(4);
});

test("Enter at position 0 does not misread the line start", () => {
  const v = "\nfoo"; // guard: lastIndexOf("\n", -1) still probes index 0
  const r = apply(v, newlineEdit(v, 0, 0));
  expect(r.text).toBe("\n\nfoo");
  expect(r.selStart).toBe(1);
});
