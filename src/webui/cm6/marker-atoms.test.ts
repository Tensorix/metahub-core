// markerAtomsField: atomic ranges cover the hidden indent+marker of CONSTANT
// markers (bullet, todo) ONLY — numbered ordinals are ordinary editable text
// (literal numbers are authoritative), and heading/quote keep caret-driven
// reveal, so neither may be atomic.
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

test("the set tracks document changes", () => {
  const st = EditorState.create({ doc: "para", extensions: [docModelField, markerAtomsField] });
  const next = st.update({ changes: { from: 0, to: 4, insert: "- item" } }).state;
  const out: [number, number][] = [];
  next.field(markerAtomsField).between(0, next.doc.length, (from, to) => {
    out.push([from, to]);
  });
  expect(out).toEqual([[0, 2]]);
});
