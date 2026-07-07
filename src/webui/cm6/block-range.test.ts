// Block-unit ranges (block-range.ts): blockAt answers the whole span of a
// multi-line block — a void's source lines, and a quote's contiguous same-level
// run — so Mod-a (selectStaged), Mod-d (duplicateBlock), and the gutter act on
// the same unit Tab steps. Headless: the helpers only read view.state (and
// dispatch), so a minimal stub stands in for EditorView (same pattern as
// reindent.test.ts).
import { test, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docModelField, docModel } from "./doc-model";
import { quoteRunAt } from "./blockmodel";
import { blockAt, blockSpanWithChildren, selectStaged, duplicateBlock } from "./block-range";

function mkView(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [docModelField],
  });
  return {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
}

// ---- quoteRunAt boundaries ----

test("quoteRunAt spans contiguous same-level quote lines", () => {
  const v = mkView("> a\n> b\n> c");
  const run = quoteRunAt(docModel(v.state).lines, 2);
  expect([run.fromLine, run.toLine]).toEqual([1, 3]);
});

test("quoteRunAt is bounded by blanks, other roles, and other levels", () => {
  //          1      2  3      4            5      6
  const v = mkView("> up\n\n> a\n  > deeper\n> b\npara");
  const lines = docModel(v.state).lines;
  expect(quoteRunAt(lines, 1)).toEqual({ fromLine: 1, toLine: 1 }); // blank below
  expect(quoteRunAt(lines, 3)).toEqual({ fromLine: 3, toLine: 3 }); // deeper below
  expect(quoteRunAt(lines, 4)).toEqual({ fromLine: 4, toLine: 4 }); // level-1 island
  expect(quoteRunAt(lines, 5)).toEqual({ fromLine: 5, toLine: 5 }); // para below
});

// ---- blockAt: quote runs are one block ----

test("blockAt answers the whole quote run from any of its lines", () => {
  const doc = "para\n> a\n> b\ntail";
  const v = mkView(doc);
  const expected = { fromLine: 2, toLine: 3, from: 5, to: doc.indexOf("\ntail") };
  expect(blockAt(v, 2)).toEqual(expected);
  expect(blockAt(v, 3)).toEqual(expected);
});

test("blockAt on a non-quote line is still that single line", () => {
  const v = mkView("para\n> a");
  expect(blockAt(v, 1)).toEqual({ fromLine: 1, toLine: 1, from: 0, to: 4 });
});

test("blockSpanWithChildren keeps a quote run intact (non-list base)", () => {
  const v = mkView("> a\n> b");
  expect(blockSpanWithChildren(v, 1)).toEqual({ fromLine: 1, toLine: 2, from: 0, to: 7 });
});

// ---- Mod-a / Mod-d act on the run ----

test("selectStaged first selects the caret's whole quote run, then the doc", () => {
  const doc = "para\n> a\n> b\ntail";
  const v = mkView(doc, doc.indexOf("> a") + 2);
  selectStaged(v);
  expect([v.state.selection.main.from, v.state.selection.main.to]).toEqual([5, 12]);
  selectStaged(v);
  expect([v.state.selection.main.from, v.state.selection.main.to]).toEqual([0, doc.length]);
});

test("duplicateBlock copies the whole quote run from a middle line", () => {
  const doc = "> a\n> b\ntail";
  const v = mkView(doc, 1);
  duplicateBlock(v);
  expect(v.state.doc.toString()).toBe("> a\n> b\n> a\n> b\ntail");
});
