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

// ---- whole-run stepping: a multi-line quote indents/outdents as ONE block ----

test("Tab on a quote line steps the whole contiguous run", () => {
  const doc = "> a\n> b\n> c\ntail";
  const v = mkView(doc, doc.indexOf("b")); // caret on the middle line
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  > a\n  > b\n  > c\ntail");
});

test("Shift-Tab on a quote line steps the whole run back", () => {
  const doc = "  > a\n  > b\ntail";
  const v = mkView(doc, doc.indexOf("a"));
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("> a\n> b\ntail");
});

test("a quote run is bounded by blanks, other roles, and other levels", () => {
  const doc = "> up\n\n> a\n  > deeper\n> b\npara";
  const v = mkView(doc, doc.indexOf("a"));
  indentCommand(v);
  // only the caret's level-0 run ("> a") moves — the blank-separated "> up",
  // the deeper line, and "> b" (a different run once "a" moved) stay put…
  expect(v.state.doc.toString()).toBe("> up\n\n  > a\n  > deeper\n> b\npara");
});

test("Tab normalizes odd indents across the run while stepping", () => {
  const doc = "> a\n > b"; // second line: odd 1-space (still level 0)
  const v = mkView(doc, 2);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("  > a\n  > b");
});

test("Shift-Tab on an odd-indent quote run snaps to canonical first", () => {
  const doc = "   > a\n   > b"; // 3 spaces: level 1 + remainder
  const v = mkView(doc, doc.indexOf("a"));
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  > a\n  > b"); // snapped, not stepped
  outdentCommand(v);
  expect(v.state.doc.toString()).toBe("> a\n> b");
});

test("Shift-Tab on a flush-left quote run consumes the key, doc unchanged", () => {
  const doc = "> a\n> b";
  const v = mkView(doc, 2);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe(doc);
});

test("caret rides along when its quote run steps", () => {
  const doc = "> a\n> b";
  const at = doc.indexOf("b") + 1; // end of second line
  const v = mkView(doc, at);
  indentCommand(v);
  expect(v.state.selection.main.head).toBe(v.state.doc.length); // still after "b"
});

// ---- whole-void stepping: a void indents/outdents as ONE block ----

test("Tab on a selected void indents every source line uniformly", () => {
  const doc = "```js\ncode\n  deep\n```";
  const v = mkView(doc, 0, doc.length);
  expect(indentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("  ```js\n  code\n    deep\n  ```");
  // exact-cover selection stays pinned to the void span (accent ring survives)
  expect(v.state.selection.main.from).toBe(0);
  expect(v.state.selection.main.to).toBe(v.state.doc.length);
});

test("Shift-Tab on a selected void strips the block indent, never the code's own", () => {
  const doc = "  ```js\n  code\n    deep\n  ```";
  const v = mkView(doc, 0, doc.length);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("```js\ncode\n  deep\n```");
  expect(v.state.selection.main.from).toBe(0);
  expect(v.state.selection.main.to).toBe(v.state.doc.length);
});

test("Shift-Tab on a flush-left void is a whole-void no-op (key consumed)", () => {
  const doc = "```\n  indented code\n```";
  const v = mkView(doc, 0, doc.length);
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe(doc); // interior indent untouched
});

test("stepping a void never rewrites the code's literal tabs", () => {
  const doc = "```\n\tcode\n```";
  const v = mkView(doc, 0, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("  ```\n  \tcode\n  ```");
  outdentCommand(v);
  expect(v.state.doc.toString()).toBe("```\n\tcode\n```");
});

test("Mod-A-style selection over prose + void steps the void as one block", () => {
  const doc = "para\n```\n\tx\n```\ntail";
  const v = mkView(doc, 0, doc.length);
  indentCommand(v);
  expect(v.state.doc.toString()).toBe("  para\n  ```\n  \tx\n  ```\n  tail");
});

test("Shift-Tab inside revealed html source keeps the per-line code dedent", () => {
  const doc = "```mh-html\n  <b>x</b>\n```";
  const v = mkView(doc, doc.indexOf("<b>")); // caret inside the source line
  expect(outdentCommand(v)).toBe(true);
  expect(v.state.doc.toString()).toBe("```mh-html\n<b>x</b>\n```"); // only that line
});
