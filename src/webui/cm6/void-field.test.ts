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
import { voidInterior } from "./blockmodel";
import { voidField, clampVoidSelection } from "./voids/void-field";

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

test("insertion exactly at a void's from keeps the gen key on the line start", () => {
  const state = mkState();
  const v = tableVoid(state);
  // Edit inside → gen 1.
  const tr1 = state.update({ changes: { from: v.from + 2, to: v.from + 3, insert: "X" } });
  const v1 = tableVoid(tr1.state);
  // Whole-block indent shape: insert at every source line start (reindent's
  // uniform step — the delimiter row must shift with the header or the table
  // stops parsing). assoc -1 keeps the key AT the opening line start, so the
  // bump continues the counter (1 → 2) instead of restarting a fresh one at 1
  // while the old entry drifts off.
  const lineStarts = [];
  for (let n = v1.fromLine; n <= v1.toLine; n++) lineStarts.push(tr1.state.doc.line(n).from);
  const tr2 = tr1.state.update({ changes: lineStarts.map((from) => ({ from, insert: "  " })) });
  const v2 = tableVoid(tr2.state);
  expect(v2.from).toBe(v1.from); // still starts at the same line start
  expect(tr2.state.field(voidField).gens.get(v2.from)).toBe(2);
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

// ---- whole-block visual indent: the widget carries the opening line's level ----

test("an indented void's widget carries its nesting level; flush-left is 0", () => {
  const indented = EditorState.create({
    doc: "  | a |\n  | --- |\n  | 1 |",
    extensions: [docModelField, voidField],
  });
  const flush = mkState();
  const widgetOf = (s: EditorState) => {
    const it = s.field(voidField).deco.iter();
    if (!it.value) throw new Error("no void deco");
    return it.value.spec.widget as { level: number };
  };
  expect(widgetOf(indented).level).toBe(1);
  expect(widgetOf(flush).level).toBe(0);
});

test("indenting a void's source lines re-levels its widget", () => {
  const state = EditorState.create({
    doc: "| a |\n| --- |\n| 1 |",
    extensions: [docModelField, voidField],
  });
  const v = tableVoid(state);
  const lines = [];
  for (let n = v.fromLine; n <= v.toLine; n++) lines.push(state.doc.line(n).from);
  const tr = state.update({ changes: lines.map((from) => ({ from, insert: "  " })) });
  const it = tr.state.field(voidField).deco.iter();
  expect((it.value!.spec.widget as { level: number }).level).toBe(1);
});

// ---- void boundary contract: voidInterior + clampVoidSelection ----
// atomicRanges only constrains cursor MOTION; a dispatched selection can land
// anywhere. clampVoidSelection is the invariant that no selection endpoint sits
// strictly inside an ATOMIC void's source (edges are legal caret stops).

const CODE_DOC = "para\n```js\ncode line\n```\ntail";
const HTML_DOC = "para\n```mh-html\n<b>x</b>\n```\ntail";

function clampState(doc: string) {
  return EditorState.create({ doc, extensions: [docModelField, clampVoidSelection] });
}

function onlyVoid(state: EditorState) {
  const v = docModel(state).voids[0];
  if (!v) throw new Error("fixture has no void");
  return v;
}

test("voidInterior: strict interior only, endpoints excluded", () => {
  const state = clampState(CODE_DOC);
  const v = onlyVoid(state);
  expect(voidInterior(docModel(state), v.from)).toBeNull();
  expect(voidInterior(docModel(state), v.to)).toBeNull();
  expect(voidInterior(docModel(state), v.from + 1)?.from).toBe(v.from);
});

test("clamp: dispatched caret inside an atomic void snaps to the nearest edge", () => {
  const state = clampState(CODE_DOC);
  const v = onlyVoid(state);
  const near = state.update({ selection: { anchor: v.from + 2 } }).state;
  expect(near.selection.main.head).toBe(v.from);
  const far = state.update({ selection: { anchor: v.to - 1 } }).state;
  expect(far.selection.main.head).toBe(v.to);
});

test("clamp: void edges are legal caret stops, untouched", () => {
  const state = clampState(CODE_DOC);
  const v = onlyVoid(state);
  expect(state.update({ selection: { anchor: v.from } }).state.selection.main.head).toBe(v.from);
  expect(state.update({ selection: { anchor: v.to } }).state.selection.main.head).toBe(v.to);
});

test("clamp: html voids are reveal-to-edit (non-atomic) — interior selection allowed", () => {
  const state = clampState(HTML_DOC);
  const v = onlyVoid(state);
  expect(v.kind).toBe("html");
  const anchor = v.from + 12; // inside the html source
  expect(state.update({ selection: { anchor } }).state.selection.main.head).toBe(anchor);
});

test("clamp: non-empty range endpoints snap without collapsing the range", () => {
  const state = clampState(CODE_DOC);
  const v = onlyVoid(state);
  const next = state.update({ selection: { anchor: 0, head: v.from + 2 } }).state;
  expect(next.selection.main.anchor).toBe(0);
  expect(next.selection.main.head).toBe(v.from);
});
