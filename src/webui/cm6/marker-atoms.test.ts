// markerAtomsField: atomic ranges cover (a) the hidden indent+marker of
// CONSTANT markers (bullet, todo) and (b) the renderer-hidden indent prefix of
// every other indented non-void line (hiddenIndentChars). Numbered ordinals
// stay ordinary editable text (literal numbers are authoritative), and
// heading/quote markers keep caret-driven reveal, so those are never atomic —
// only the invisible indent in front of them is.
import { test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { docModelField } from "./doc-model";
import { markerAtomsField } from "./marker-atoms";

function spans(doc: string): [number, number][] {
  const st = EditorState.create({ doc, extensions: [docModelField, markerAtomsField] });
  const out: [number, number][] = [];
  st.field(markerAtomsField).between(0, st.doc.length, (from, to) => {
    out.push([from, to]);
  });
  return out;
}

test("bullet and todo markers are atomic, indent included", () => {
  const doc = "- a\n  - [ ] b";
  const l2 = doc.indexOf("  - [ ] b");
  expect(spans(doc)).toEqual([
    [0, 2], // "- "
    [l2, l2 + 8], // "  - [ ] "
  ]);
});

test("numbered, heading, quote, and prose lines are NOT atomic", () => {
  expect(spans("1. a\n# h\n> q\npara")).toEqual([]);
});

test("an indented paragraph's hidden indent is atomic", () => {
  expect(spans("  para")).toEqual([[0, 2]]);
});

test("a nested numbered item's hidden indent is atomic, digits excluded", () => {
  expect(spans("  1. a")).toEqual([[0, 2]]); // [from, markerFrom) only
});

test("indented heading, quote, and blank lines get hidden-indent atoms", () => {
  // Line starts: "  ## t" @0, "  > q" @7, "  " @13.
  expect(spans("  ## t\n  > q\n  ")).toEqual([
    [0, 2],
    [7, 9],
    [13, 15],
  ]);
});

test("a tab indent hides by COLUMN width: one tab char covers 4 columns", () => {
  // "\tpara": indent 4 cols → level 2 → hide target 4 cols = 1 tab char.
  expect(spans("\tpara")).toEqual([[0, 1]]);
});

test("an odd remainder space stays visible (non-atomic)", () => {
  // 3 spaces: level 1 → 2 chars hidden, the 3rd space is literal text.
  expect(spans("   para")).toEqual([[0, 2]]);
});

test("indent beyond MAX_NEST stays visible", () => {
  // 20 spaces = level 10 → hide caps at MAX_NEST(8)*2 = 16 chars.
  expect(spans(" ".repeat(20) + "para")).toEqual([[0, 16]]);
});

test("the set tracks document changes", () => {
  const st = EditorState.create({ doc: "para", extensions: [docModelField, markerAtomsField] });
  const next = st.update({ changes: { from: 0, to: 4, insert: "- item" } }).state;
  const out: [number, number][] = [];
  next.field(markerAtomsField).between(0, next.doc.length, (from, to) => {
    out.push([from, to]);
  });
  expect(out).toEqual([[0, 2]]);
});
