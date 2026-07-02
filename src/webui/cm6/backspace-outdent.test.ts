// Backspace at the first visible char of a fully-hidden indent (structure.ts
// backspaceCommand): the leading whitespace covering the canonical level*2
// columns is invisible behind the 24px column grid, so Backspace must step out
// ONE LEVEL instead of eating one invisible space. Numbered items re-level
// through relevelNumbered (same path as Shift-Tab) so their ordinal regenerates;
// a visible odd remainder space falls through to the default char delete; a
// whitespace-only line keeps its stronger whole-run delete.
//
// Headless: backspaceCommand only touches view.{composing,state,dispatch}, so a
// three-member stub stands in for EditorView (same pattern as reindent.test.ts).
// structure.ts pulls in Preact void widgets — register happy-dom for this file
// only.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docModelField } from "./doc-model";
import { backspaceCommand } from "./structure";
import { markerAtomsField } from "./marker-atoms";

afterAll(() => GlobalRegistrator.unregister());

const EXT = [docModelField, markerAtomsField];

/** Minimal EditorView stand-in: backspaceCommand reads composing/state and dispatches. */
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

test("Backspace at the content start of an indented paragraph outdents one level", () => {
  const v = mkView("    para", 4); // caret at markerFrom, indent fully hidden
  expect(backspaceCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  para");
  expect(v.state.selection.main.head).toBe(2); // caret stays at the content start
});

test("a visible odd remainder space falls through to the default delete", () => {
  const v = mkView("   para", 3); // level 1 hides 2 chars; the 3rd space is visible
  expect(backspaceCommand(v)).toBe(false); // default Backspace eats the visible space
  expect(v.state.doc.toString()).toBe("   para"); // command itself changed nothing
});

test("a nested numbered item re-levels and regenerates its ordinal", () => {
  const doc = "1. a\n  2. b";
  const v = mkView(doc, doc.indexOf("2.")); // caret at line 2's markerFrom
  expect(backspaceCommand(v)).toBe(true);
  // relevelNumbered semantics: at level 0 it continues the previous sibling's
  // literal number ("1. a" → 2), and the caret lands at the new content start.
  expect(v.state.doc.toString()).toBe("1. a\n2. b");
  expect(v.state.selection.main.head).toBe(doc.indexOf("\n") + 1 + 3); // after "2. "
});

test("a whitespace-only line still whole-run-deletes (existing branch wins)", () => {
  const doc = "a\n    ";
  const v = mkView(doc, doc.length); // caret after the invisible run
  expect(backspaceCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("a\n"); // whole run gone, not one level
  expect(v.state.selection.main.head).toBe(2);
});
