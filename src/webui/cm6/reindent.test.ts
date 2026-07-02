// Tab / Shift-Tab semantics (structure.ts reindent): a blank line is a no-op, a
// paragraph indents ONLY as a list continuation (old-editor parity: prose never
// indents on its own), revealed void source keeps real space insertion, and any
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

test("Tab on a blank line is a no-op (key consumed, nothing inserted)", () => {
  const v = mkView("a\n\nb", 2);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n\nb");
});

test("Tab on a whitespace-only line is a no-op", () => {
  const v = mkView("a\n  \nb", 3);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n  \nb");
});

test("Tab on a paragraph with no list above is a no-op", () => {
  const v = mkView("para one\npara two", 10);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("para one\npara two");
});

test("Tab nests a paragraph under the list item above as a continuation", () => {
  const doc = "- item\ntail";
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\n  tail");
  expect(v.state.selection.main.head).toBe(v.state.doc.length); // caret rides along
});

test("continuation depth caps one level below the item — a second Tab is a no-op", () => {
  const v = mkView("- item\n  tail", 13);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\n  tail");
});

test("after a sibling continuation the cap is the sibling's level, not one deeper", () => {
  const doc = "- item\n  one\ntwo";
  const v = mkView(doc, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\n  one\n  two");
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("- item\n  one\n  two"); // capped at the sibling
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
