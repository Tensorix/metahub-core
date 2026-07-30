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
import { backspaceCommand, makeMergeTop } from "./structure";
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

// Backspace at offset 0 (makeMergeTop): the block above the first line is the
// TITLE, so the line merges into it — the host takes the text, the line goes.
// backspaceCommand declines at offset 0, which is what leaves room for this.

/** Collects what the title host was handed; `ok` fakes "a title is mounted". */
function mkMerge(ok = true) {
  const seen: string[] = [];
  return {
    seen,
    cmd: makeMergeTop((text) => {
      seen.push(text);
      return ok;
    }),
  };
}

test("Backspace at offset 0 hands the first line to the title and deletes it", () => {
  const m = mkMerge();
  const v = mkView("first\nsecond", 0);
  expect(m.cmd(v)).toBe(true);
  expect(m.seen).toEqual(["first"]);
  expect(v.state.doc.toString()).toBe("second"); // line AND its newline
});

test("an empty first line merges nothing and just disappears", () => {
  const m = mkMerge();
  const v = mkView("\nbody", 0);
  expect(m.cmd(v)).toBe(true);
  expect(m.seen).toEqual([""]);
  expect(v.state.doc.toString()).toBe("body");
});

test("the merged text is the line's CONTENT — the marker dies with the block", () => {
  const m = mkMerge();
  const v = mkView("1. foo\nbar", 0);
  expect(m.cmd(v)).toBe(true);
  expect(m.seen).toEqual(["foo"]); // not "1. foo"
  expect(v.state.doc.toString()).toBe("bar");
});

test("a single-line document merges and leaves an empty body", () => {
  const m = mkMerge();
  const v = mkView("only", 0);
  expect(m.cmd(v)).toBe(true);
  expect(m.seen).toEqual(["only"]);
  expect(v.state.doc.toString()).toBe("");
});

test("a void opening the document keeps its own Backspace", () => {
  const m = mkMerge();
  const doc = "```js\nx\n```\ntail";
  const v = mkView(doc, 0);
  expect(m.cmd(v)).toBe(false);
  expect(m.seen).toEqual([]);
  expect(v.state.doc.toString()).toBe(doc);
});

test("no merge away from offset 0, on a selection, or without a title host", () => {
  const away = mkMerge();
  expect(away.cmd(mkView("first\nsecond", 1))).toBe(false);

  const ranged = mkMerge();
  expect(ranged.cmd(mkView("first\nsecond", 0, 3))).toBe(false);

  const noHost = mkMerge(false); // host declined (no title mounted)
  const v = mkView("first\nsecond", 0);
  expect(noHost.cmd(v)).toBe(false);
  expect(v.state.doc.toString()).toBe("first\nsecond"); // nothing deleted

  expect(makeMergeTop(undefined)(mkView("first", 0))).toBe(false);
});

test("backspaceCommand itself still declines at offset 0 (the two don't compete)", () => {
  expect(backspaceCommand(mkView("# h\nbody", 0))).toBe(false);
  expect(backspaceCommand(mkView("para", 0))).toBe(false);
});
