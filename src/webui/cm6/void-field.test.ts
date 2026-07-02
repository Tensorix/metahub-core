// Generation-invalidation contract of voidField (see voids/void-field.tsx):
// an EXTERNAL doc change (anything but our own "input.writeback") that intersects
// a void bumps that void's generation — forcing the focused-island eq() special
// case to fail so the widget rebuilds from document truth. Self write-backs and
// changes elsewhere must NOT bump (they'd tear down the caret mid-typing).
//
// voidField pulls in the Preact widget components, whose modules expect a DOM at
// import time in places — register happy-dom for this file only (same pattern as
// markdown.dom.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { docModelField, docModel } from "./doc-model";
import { voidField } from "./voids/void-field";

afterAll(() => GlobalRegistrator.unregister());

const DOC = "para\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntail";

function mkState() {
  return EditorState.create({ doc: DOC, extensions: [docModelField, voidField] });
}

function tableVoid(state: EditorState) {
  const v = docModel(state).voids.find((v) => v.kind === "table");
  if (!v) throw new Error("fixture has no table void");
  return v;
}

test("external change inside a void bumps its generation", () => {
  const state = mkState();
  const v = tableVoid(state);
  expect(state.field(voidField).gens.get(v.from) ?? 0).toBe(0);

  const tr = state.update({ changes: { from: v.from + 2, to: v.from + 3, insert: "X" } });
  const v2 = tableVoid(tr.state);
  expect(tr.state.field(voidField).gens.get(v2.from)).toBe(1);
});

test("self write-back does not bump the generation", () => {
  const state = mkState();
  const v = tableVoid(state);
  const tr = state.update({
    changes: { from: v.from + 2, to: v.from + 3, insert: "X" },
    userEvent: "input.writeback",
  });
  const v2 = tableVoid(tr.state);
  expect(tr.state.field(voidField).gens.get(v2.from) ?? 0).toBe(0);
});

test("change outside the void does not bump; existing gens remap through edits", () => {
  const state = mkState();
  const v = tableVoid(state);

  // First: external edit inside the table → gen 1.
  const tr1 = state.update({ changes: { from: v.from + 2, to: v.from + 3, insert: "X" } });
  const vAfter1 = tableVoid(tr1.state);
  expect(tr1.state.field(voidField).gens.get(vAfter1.from)).toBe(1);

  // Then: insert text at the very start of the doc (outside the void). The gen
  // entry must follow the void to its shifted position, unchanged.
  const tr2 = tr1.state.update({ changes: { from: 0, insert: "intro " } });
  const vAfter2 = tableVoid(tr2.state);
  expect(vAfter2.from).toBeGreaterThan(vAfter1.from);
  expect(tr2.state.field(voidField).gens.get(vAfter2.from)).toBe(1);
});

test("undo-style non-writeback events bump like any external change", () => {
  const state = mkState();
  const v = tableVoid(state);
  const tr = state.update({
    changes: { from: v.from + 2, to: v.from + 3, insert: "Y" },
    userEvent: "undo",
  });
  const v2 = tableVoid(tr.state);
  expect(tr.state.field(voidField).gens.get(v2.from)).toBe(1);
});
