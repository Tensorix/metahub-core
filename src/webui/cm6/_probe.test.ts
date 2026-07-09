import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
import { afterAll, test, expect } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docModelField } from "./doc-model";
import { markerAtomsField } from "./marker-atoms";
import { enterCommand, backspaceCommand, indentCommand, outdentCommand } from "./structure";
import { scanDoc, correctNumberAtLevel } from "./blockmodel";

afterAll(() => GlobalRegistrator.unregister());
const EXT = [docModelField, markerAtomsField];

function mkView(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: EXT });
  return {
    composing: false,
    get state() { return state; },
    dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; },
  } as unknown as EditorView;
}

test("PROBE enter continues numbered from literal number", () => {
  const doc = "5. five";
  const v = mkView(doc, doc.length);
  enterCommand(v);
  console.log("num-continue:", JSON.stringify(v.state.doc.toString()), "head=", v.state.selection.main.head);
});

test("PROBE enter continues numbered with leading zero", () => {
  const doc = "007. x";
  const v = mkView(doc, doc.length);
  enterCommand(v);
  console.log("leadingzero:", JSON.stringify(v.state.doc.toString()));
});

test("PROBE enter on empty nested item exits to col 0", () => {
  const doc = "- a\n  - ";
  const v = mkView(doc, doc.length);
  enterCommand(v);
  console.log("empty-nested-exit:", JSON.stringify(v.state.doc.toString()), "head=", v.state.selection.main.head);
});

test("PROBE enter mid-content split of bullet", () => {
  const doc = "- hello";
  const at = doc.indexOf("llo");
  const v = mkView(doc, at);
  enterCommand(v);
  console.log("split:", JSON.stringify(v.state.doc.toString()), "head=", v.state.selection.main.head);
});

test("PROBE backspace strip marker at contentFrom of quote", () => {
  const doc = "> quoted";
  const v = mkView(doc, 2); // contentFrom
  const r = backspaceCommand(v);
  console.log("strip-quote:", r, JSON.stringify(v.state.doc.toString()));
});

test("PROBE backspace void-select after code fence", () => {
  const doc = "```\nx\n```\ntail";
  const at = doc.indexOf("tail");
  const v = mkView(doc, at);
  const r = backspaceCommand(v);
  console.log("void-select:", r, "sel=", v.state.selection.main.from, v.state.selection.main.to);
});

test("PROBE correctNumberAtLevel with num=0 predecessor", () => {
  const lines = scanDoc("0. zero\nx").lines;
  console.log("num0-continue:", correctNumberAtLevel(lines, 2, 0));
});

test("PROBE tab on numbered item with children orphans", () => {
  const doc = "1. parent\n  child text";
  const v = mkView(doc, 0);
  indentCommand(v);
  console.log("num-tab-children:", JSON.stringify(v.state.doc.toString()));
});

test("PROBE enter numbered mid marker digits", () => {
  const doc = "12. item";
  const v = mkView(doc, 1); // between 1 and 2
  const r = enterCommand(v);
  console.log("mid-digit:", r, JSON.stringify(v.state.doc.toString()), "head=", v.state.selection.main.head);
});

test("PROBE outdent numbered nested regenerates and preserves separator", () => {
  const doc = "1. a\n  2) b";
  const v = mkView(doc, doc.indexOf("2)"));
  outdentCommand(v);
  console.log("sep-outdent:", JSON.stringify(v.state.doc.toString()));
});
