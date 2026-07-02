// Tab / Shift-Tab semantics (structure.ts reindent): a blank line is a no-op, any
// other block line (paragraph/heading/quote) indents FREELY by one level per press
// (no list-context requirement, no cap — the old editor's prose-never-indents rule
// was overruled), revealed void source keeps real space insertion, and any
// leading whitespace containing literal tabs is normalized to spaces by COLUMN
// width. Headless: reindent only touches view.{composing,state,dispatch}, so a
// three-member stub stands in for EditorView.
//
// structure.ts pulls in Preact void widgets — register happy-dom for this file
// only (same pattern as renumber.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docModelField } from "./doc-model";
import { indentCommand, outdentCommand } from "./structure";
import { markerAtomsField } from "./marker-atoms";

afterAll(() => GlobalRegistrator.unregister());

const EXT = [docModelField, markerAtomsField];

/** Minimal EditorView stand-in: reindent reads composing/state and dispatches. */
function mkView(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: EXT,
  });
  return {
    composing: false,
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
}

test("Tab on an empty line indents it (empty blocks are indentable)", () => {
  const v = mkView("a\n\nb", 2);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n  \nb");
  expect(v.state.selection.main.head).toBe(4); // caret after the indent
});

test("Tab on a whitespace-only line adds another level", () => {
  const v = mkView("a\n  \nb", 4);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n    \nb");
});

test("Tab indents a free-standing paragraph by one level per press", () => {
  const v = mkView("para one\npara two", 10);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("para one\n  para two");
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("para one\n    para two"); // no cap
});

test("Tab nests a paragraph under the list item above as a continuation", () => {
  const doc = "- item\ntail";
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\n  tail");
  expect(v.state.selection.main.head).toBe(v.state.doc.length); // caret rides along
});

test("indenting rewrites an odd leading space to the level's canonical form", () => {
  const doc = " para"; // 1 space: level 0 with a visible remainder
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("  para"); // level 1, remainder absorbed
});

test("a heading nests under a list item like any continuation", () => {
  const doc = "1. item\n## h";
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("1. item\n  ## h");
});

test("Tab inside revealed void source still inserts two literal spaces", () => {
  const doc = "```\nxy\n```";
  const v = mkView(doc, doc.indexOf("xy"));
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("```\n  xy\n```");
});

test("Shift-Tab outdents a continuation by one level", () => {
  const v = mkView("- item\n  tail\n", 10);
  outdentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\ntail\n");
});

test("a tab-indented numbered item re-levels by COLUMNS and normalizes to spaces", () => {
  const doc = "\t1. x"; // \t = 4 columns = level 2
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("      1. x"); // 6 columns, no tabs
});

test("multi-line Tab normalizes tabbed indents by column width", () => {
  const doc = "a\n\tb";
  const v = mkView(doc, 0, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("  a\n      b"); // 0+2 and 4+2 columns
});

test("multi-line Shift-Tab shrinks a tabbed indent by two columns", () => {
  const doc = "  a\n\tb";
  const v = mkView(doc, 0, doc.length);
  outdentCommand(v);
  expect(v.state.doc.toString()).toBe("a\n  b");
});

test("single-caret Shift-Tab outdents a paragraph one level per press", () => {
  const doc = "    para";
  const v = mkView(doc, doc.length);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  para");
  outdentCommand(v);
  expect(v.state.doc.toString()).toBe("para");
});

test("single-caret Shift-Tab on an odd indent normalizes first", () => {
  const doc = "   para"; // 3 spaces: level 1 with a visible remainder
  const v = mkView(doc, doc.length);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  para"); // snapped to canonical level 1
});

test("single-caret Shift-Tab at flush-left consumes the key, doc unchanged", () => {
  const v = mkView("para", 2);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("para");
});

test("single-caret Shift-Tab outdents an indented blank line", () => {
  const doc = "a\n    ";
  const v = mkView(doc, doc.length);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n  ");
});
