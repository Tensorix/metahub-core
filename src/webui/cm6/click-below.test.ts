// Click-below-the-body behavior (click-below.ts): the pure transaction builder
// is exercised over headless EditorStates (no DOM needed — it only reads the
// doc), and the mousedown handler over a stub view/event (it only touches
// view.{dom,state,dispatch,focus} and event geometry/target).

import { test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { caretToTrailingEmptyLine, handleClickBelow } from "./click-below";

/** Apply the built spec and return the resulting doc + caret. */
function apply(doc: string) {
  const state = EditorState.create({ doc });
  const spec = caretToTrailingEmptyLine(state);
  const next = state.update(spec).state;
  return { spec, doc: next.doc.toString(), caret: next.selection.main.head };
}

test("empty doc: no change, caret stays at 0", () => {
  const r = apply("");
  expect(r.spec.changes).toBeUndefined();
  expect(r.doc).toBe("");
  expect(r.caret).toBe(0);
});

test("doc ending in an empty line: selection-only move to doc end", () => {
  const r = apply("hello\n");
  expect(r.spec.changes).toBeUndefined();
  expect(r.doc).toBe("hello\n");
  expect(r.caret).toBe(6);
});

test("doc ending in a non-empty paragraph: append \\n, caret on the new line", () => {
  const r = apply("hello");
  expect(r.doc).toBe("hello\n");
  expect(r.caret).toBe(6);
  expect(r.spec.userEvent).toBe("input"); // ordinary edit: undoable, save-triggering
});

test("doc ending in a void block line (image) appends a paragraph after it", () => {
  const r = apply("para\n\n![](blob:abc.png)");
  expect(r.doc).toBe("para\n\n![](blob:abc.png)\n");
  expect(r.caret).toBe(r.doc.length);
});

test("doc ending in a closed code fence appends a paragraph after it", () => {
  const r = apply("```js\nx()\n```");
  expect(r.doc).toBe("```js\nx()\n```\n");
  expect(r.caret).toBe(r.doc.length);
});

test("whitespace-only last line is NOT empty — still appends", () => {
  const r = apply("a\n  ");
  expect(r.doc).toBe("a\n  \n");
  expect(r.caret).toBe(r.doc.length);
});

// ---- DOM handler over stubs -------------------------------------------------

/** Stub view: handleClickBelow reads dom.getBoundingClientRect().bottom,
 *  state, dispatch, focus. */
function mkView(doc: string, editorBottom: number) {
  let state = EditorState.create({ doc });
  const calls = { focused: 0 };
  const view = {
    dom: { getBoundingClientRect: () => ({ bottom: editorBottom }) },
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    focus: () => calls.focused++,
  } as unknown as EditorView;
  return { view, calls, doc: () => state.doc.toString(), caret: () => state.selection.main.head };
}

/** Stub mousedown event on `container`; target defaults to the container
 *  itself (a bare padding-area press). */
function mkEvent(clientY: number, opts: { button?: number; child?: boolean } = {}) {
  const container = {};
  const calls = { prevented: 0 };
  const event = {
    button: opts.button ?? 0,
    clientY,
    currentTarget: container,
    target: opts.child ? {} : container,
    preventDefault: () => calls.prevented++,
  } as unknown as MouseEvent;
  return { event, calls };
}

test("press below the editor bottom appends + focuses + preventDefaults", () => {
  const v = mkView("hello", 400);
  const e = mkEvent(500);
  expect(handleClickBelow(v.view, e.event)).toBe(true);
  expect(v.doc()).toBe("hello\n");
  expect(v.caret()).toBe(6);
  expect(v.calls.focused).toBe(1);
  expect(e.calls.prevented).toBe(1);
});

test("press below with an already-empty last line only moves the caret", () => {
  const v = mkView("hello\n", 400);
  expect(handleClickBelow(v.view, mkEvent(500).event)).toBe(true);
  expect(v.doc()).toBe("hello\n");
  expect(v.caret()).toBe(6);
});

test("press above/at the editor bottom is ignored (CM owns it)", () => {
  const v = mkView("hello", 400);
  expect(handleClickBelow(v.view, mkEvent(300).event)).toBe(false);
  expect(handleClickBelow(v.view, mkEvent(400).event)).toBe(false);
  expect(v.doc()).toBe("hello");
  expect(v.calls.focused).toBe(0);
});

test("press on a child element (banner/lightbox/editor DOM) is ignored", () => {
  const v = mkView("hello", 400);
  expect(handleClickBelow(v.view, mkEvent(500, { child: true }).event)).toBe(false);
  expect(v.doc()).toBe("hello");
});

test("non-primary button is ignored", () => {
  const v = mkView("hello", 400);
  expect(handleClickBelow(v.view, mkEvent(500, { button: 2 }).event)).toBe(false);
  expect(v.doc()).toBe("hello");
});
