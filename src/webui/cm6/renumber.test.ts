// Ordered-list literal convergence (renumberFilter in structure.ts): any LOCAL
// user edit touching a list cluster rewrites the cluster's literal numbers to
// the computed display numbers in the SAME transaction. Remote merges (no
// userEvent), undo/redo, island write-backs, and IME steps must pass through
// untouched, and the line whose marker holds the caret is never fought over.
//
// structure.ts pulls in void-field (Preact widgets) — register happy-dom for
// this file only, same pattern as void-field.test.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { docModelField } from "./doc-model";
import { renumberFilter } from "./structure";

afterAll(() => GlobalRegistrator.unregister());

function mkState(doc: string, anchor = 0) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor),
    extensions: [docModelField, renumberFilter()],
  });
}

test("a local edit converges a drifted run's literals to the display numbers", () => {
  // Source drifted to 1/1/1 (displays as 1/2/3); type a char at the end of item b.
  const doc = "1. a\n1. b\n1. c";
  const st = mkState(doc, doc.indexOf("b") + 1);
  const tr = st.update({
    changes: { from: doc.indexOf("b") + 1, insert: "x" },
    selection: { anchor: doc.indexOf("b") + 2 },
    userEvent: "input.type",
  });
  expect(tr.state.doc.toString()).toBe("1. a\n2. bx\n3. c");
});

test("the run head's literal is the start and is preserved", () => {
  const doc = "5. a\n5. b";
  const st = mkState(doc, doc.length);
  const tr = st.update({ changes: { from: doc.length, insert: "x" }, userEvent: "input.type" });
  expect(tr.state.doc.toString()).toBe("5. a\n6. bx");
});

test("remote merges (no userEvent) pass through untouched", () => {
  const doc = "1. a\n1. b\n1. c";
  const st = mkState(doc);
  const tr = st.update({ changes: { from: doc.length, insert: "x" } });
  expect(tr.state.doc.toString()).toBe("1. a\n1. b\n1. cx");
});

test("island write-backs and undo/redo pass through untouched", () => {
  const doc = "1. a\n1. b";
  for (const userEvent of ["input.writeback", "undo", "redo"]) {
    const st = mkState(doc);
    const tr = st.update({ changes: { from: doc.length, insert: "x" }, userEvent });
    expect(tr.state.doc.toString()).toBe("1. a\n1. bx");
  }
});

test("the line whose marker holds the caret is left alone", () => {
  // Caret sits inside the second item's marker digits (hand-editing the number):
  // that line keeps its literal; the rest of the cluster still converges.
  const doc = "1. a\n7. b\n1. c";
  const markerPos = doc.indexOf("7"); // inside [markerFrom, contentFrom)
  const st = mkState(doc, markerPos + 1);
  const tr = st.update({
    // Edit elsewhere in the cluster (append to item c) while the caret stays put.
    changes: { from: doc.length, insert: "x" },
    userEvent: "input.type",
  });
  // Item b untouched (caret guard); item c converges to displayNum (7 → 3? no:
  // display counts 1,2,3 with head start 1 — b's display is 2, c's is 3).
  expect(tr.state.doc.toString()).toBe("1. a\n7. b\n3. cx");
});

test("editing the head's number renumbers the followers from the new start", () => {
  // Replace head "1" with "7" (selection lands AFTER the digit, i.e. in the
  // marker region of the head — the head keeps the user's value by both the
  // caret guard and start semantics; followers converge to 8/9).
  const doc = "1. a\n2. b\n3. c";
  const st = mkState(doc, 1);
  const tr = st.update({
    changes: { from: 0, to: 1, insert: "7" },
    selection: { anchor: 1 },
    userEvent: "input.type",
  });
  expect(tr.state.doc.toString()).toBe("7. a\n8. b\n9. c");
});

test("mid-run Enter-style insertion converges the following siblings", () => {
  // Simulate what enterCommand dispatches after item a of 1/2: insert "\n2. "
  // (correct next literal); the stale following sibling (literal 2) converges to 3.
  const doc = "1. a\n2. b";
  const at = doc.indexOf("a") + 1;
  const st = mkState(doc, at);
  const tr = st.update({
    changes: { from: at, insert: "\n2. " },
    selection: { anchor: at + 4 },
    userEvent: "input",
  });
  expect(tr.state.doc.toString()).toBe("1. a\n2. \n3. b");
});

test("pasting drifted items into a run converges the whole cluster", () => {
  const doc = "1. a\n2. b";
  const at = doc.indexOf("a") + 1;
  const st = mkState(doc, at);
  const tr = st.update({
    changes: { from: at, insert: "\n1. p\n1. q" },
    selection: { anchor: at + 5 },
    userEvent: "input.paste",
  });
  expect(tr.state.doc.toString()).toBe("1. a\n2. p\n3. q\n4. b");
});

test("clusters separated by prose are not touched", () => {
  const doc = "1. a\n1. b\n\npara\n\n1. x\n1. y";
  const st = mkState(doc, doc.indexOf("b") + 1);
  const tr = st.update({
    changes: { from: doc.indexOf("b") + 1, insert: "!" },
    userEvent: "input.type",
  });
  // First cluster converges; the second (beyond the prose break) is untouched.
  expect(tr.state.doc.toString()).toBe("1. a\n2. b!\n\npara\n\n1. x\n1. y");
});

test("multi-digit and separator styles keep their width and glyph", () => {
  const doc = "9. a\n07) b";
  const st = mkState(doc, doc.length);
  const tr = st.update({ changes: { from: doc.length, insert: "x" }, userEvent: "input.type" });
  // 07) is the same run (level 0): display 10; digits "07" replaced by "10", ")" kept.
  expect(tr.state.doc.toString()).toBe("9. a\n10) bx");
});
