// fenceContinuation: the pure computation behind "type ``` inside a list item /
// quote, press Enter, get a nested code block". Cases cover markers, langs,
// nesting depth, the ~~~ variant, and the exactness rule; the round-trip block
// asserts the produced text scans as a code void (blockmodel) AND parses back as
// the item's child code block (blocks.ts), so editor, save path, and share page
// all agree on the result.
//
// structure.ts imports the void widget module (for focusCodeVoid), which pulls in
// Preact components that expect a DOM at import time — register happy-dom for
// this file only (same pattern as void-field.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, describe, test, expect } from "bun:test";
import { scanDoc, type LineInfo } from "./blockmodel";
import { fenceContinuation } from "./structure";
import { blocksFromBody, type Block } from "../blocks";

afterAll(() => GlobalRegistrator.unregister());

/** The scanned LineInfo for 1-based line `n` of `src`. */
function lineOf(src: string, n = 1): LineInfo {
  return scanDoc(src).lines[n - 1]!;
}

/** Apply a fenceContinuation change to the source string; returns the new text
 *  and the absolute caret position. */
function apply(src: string, n = 1): { out: string; caret: number } {
  const line = lineOf(src, n);
  const fc = fenceContinuation(line);
  if (!fc) throw new Error("fenceContinuation returned null");
  return {
    out: src.slice(0, fc.insertFrom) + fc.insert + src.slice(fc.insertTo),
    caret: fc.insertFrom + fc.caretOffset,
  };
}

describe("fenceContinuation", () => {
  test("bullet + ``` → nested fence pair, item keeps its bare marker", () => {
    const { out, caret } = apply("- ```");
    expect(out).toBe("- \n  ```\n  \n  ```");
    // Caret at the end of the middle (empty code) line, after the child indent.
    expect(out.slice(0, caret)).toBe("- \n  ```\n  ");
  });

  test("numbered + ```js keeps the lang on the opener", () => {
    const { out, caret } = apply("1. ```js");
    expect(out).toBe("1. \n  ```js\n  \n  ```");
    expect(out.slice(0, caret).endsWith("```js\n  ")).toBe(true);
  });

  test("todo item", () => {
    const { out } = apply("- [ ] ```");
    expect(out).toBe("- [ ] \n  ```\n  \n  ```");
  });

  test("nested item: indent 2 → child indent 4 (columns)", () => {
    const src = "- a\n  - ```";
    const { out } = apply(src, 2);
    expect(out).toBe("- a\n  - \n    ```\n    \n    ```");
  });

  test("quote line rewrites to a top-level fence pair (quotes cannot nest fences)", () => {
    const { out, caret } = apply("> ```");
    expect(out).toBe("```\n\n```");
    expect(caret).toBe(4); // end of the middle blank line
  });

  test("indented quote keeps the line's own indent", () => {
    const src = "  > ```py";
    const { out } = apply(src);
    expect(out).toBe("  ```py\n  \n  ```");
  });

  test("content that is not EXACTLY a fence opener → null", () => {
    expect(fenceContinuation(lineOf("- x ```"))).toBeNull(); // text before the fence
    expect(fenceContinuation(lineOf("- ``` js"))).toBeNull(); // space inside
    expect(fenceContinuation(lineOf("- ```js extra"))).toBeNull(); // trailing text
    expect(fenceContinuation(lineOf("- ``"))).toBeNull(); // too short
  });

  test("non-list, non-quote roles → null", () => {
    expect(fenceContinuation(lineOf("```"))).toBeNull(); // p (handled by the p-branch)
    expect(fenceContinuation(lineOf("# ```"))).toBeNull(); // heading
  });

  test("~~~ variant closes with the same char and length", () => {
    const { out } = apply("- ~~~~py");
    expect(out).toBe("- \n  ~~~~py\n  \n  ~~~~");
  });
});

describe("fenceContinuation round-trip", () => {
  test("scanDoc sees a code void nested under the item", () => {
    const { out } = apply("- ```ts");
    const model = scanDoc(out);
    expect(model.voids).toHaveLength(1);
    const v = model.voids[0]!;
    expect(v.kind).toBe("code");
    expect(v.fromLine).toBe(2); // opener on the line after the item
    expect(v.toLine).toBe(4);
    expect(v.block.lang).toBe("ts");
    expect(model.lines[1]!.indent).toBe(2); // child indent in columns
    // The item line itself still scans as a (now empty) bullet.
    expect(model.lines[0]!.role).toBe("bullet");
  });

  test("blocksFromBody parses the code block as the list item's child", () => {
    const { out } = apply("- ```ts");
    const blocks = blocksFromBody(out);
    expect(blocks).toHaveLength(1);
    const item = blocks[0]!;
    expect(item.type).toBe("bullet");
    expect(item.content).toBe("");
    const children = (item.children ?? []) as Block[];
    expect(children).toHaveLength(1);
    expect(children[0]!.type).toBe("code");
    expect(children[0]!.lang).toBe("ts");
  });

  test("two-level nesting round-trips as grandchild code", () => {
    const { out } = apply("- a\n  - ```", 2);
    const model = scanDoc(out);
    expect(model.voids).toHaveLength(1);
    expect(model.voids[0]!.kind).toBe("code");
    expect(model.lines[2]!.indent).toBe(4);

    const blocks = blocksFromBody(out);
    const inner = blocks[0]!.children?.[0];
    expect(inner?.type).toBe("bullet");
    expect(inner?.children?.[0]?.type).toBe("code");
  });

  test("quote rewrite yields a plain top-level code block", () => {
    const { out } = apply("> ```js");
    const model = scanDoc(out);
    expect(model.voids).toHaveLength(1);
    expect(model.voids[0]!.kind).toBe("code");
    expect(model.voids[0]!.fromLine).toBe(1);

    const blocks = blocksFromBody(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
    expect(blocks[0]!.lang).toBe("js");
  });
});

// ---- enterDocTop: title → body entry point ----
// Stub view (same pattern as click-below.test.ts): enterDocTop only touches
// view.state / view.dispatch / view.focus.
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docModelField } from "./doc-model";
import { enterDocTop, splitDocTop } from "./structure";

function stubView(doc: string) {
  let state = EditorState.create({ doc, extensions: [docModelField] });
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) { state = state.update(spec as never).state; },
    focus() {},
  } as unknown as EditorView;
  return { view, current: () => state };
}

describe("enterDocTop", () => {
  test("prose first block: caret to 0, doc untouched", () => {
    const { view, current } = stubView("hello\nworld");
    enterDocTop(view);
    expect(current().doc.toString()).toBe("hello\nworld");
    expect(current().selection.main.head).toBe(0);
  });

  test("empty doc: caret to 0, no change", () => {
    const { view, current } = stubView("");
    enterDocTop(view);
    expect(current().doc.toString()).toBe("");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading image void: a fresh line opens above, void source intact", () => {
    const { view, current } = stubView("![a](blob:x.png)\ntail");
    enterDocTop(view);
    expect(current().doc.toString()).toBe("\n![a](blob:x.png)\ntail");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading code fence: same fresh-line entry, fence not corrupted", () => {
    const { view, current } = stubView("```js\nx()\n```");
    enterDocTop(view);
    expect(current().doc.toString()).toBe("\n```js\nx()\n```");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading table: fresh line above the header row", () => {
    const { view, current } = stubView("| a |\n| --- |\n| 1 |");
    enterDocTop(view);
    expect(current().doc.toString()).toBe("\n| a |\n| --- |\n| 1 |");
    expect(current().selection.main.head).toBe(0);
  });
});

// ---- splitDocTop: Enter in the title, the text right of the caret comes down ----
describe("splitDocTop", () => {
  test("carried text becomes the new first block, caret at its start", () => {
    const { view, current } = stubView("第一段");
    splitDocTop(view, "后半");
    expect(current().doc.toString()).toBe("后半\n第一段");
    expect(current().selection.main.head).toBe(0);
  });

  test("empty doc: no trailing newline behind the carried text", () => {
    const { view, current } = stubView("");
    splitDocTop(view, "后半");
    expect(current().doc.toString()).toBe("后半");
    expect(current().selection.main.head).toBe(0);
  });

  test("caret at the title's end: an empty paragraph opens above the first block", () => {
    const { view, current } = stubView("第一段");
    splitDocTop(view, "");
    expect(current().doc.toString()).toBe("\n第一段");
    expect(current().selection.main.head).toBe(0);
  });

  test("caret at the end, top already blank: no second blank line stacks up", () => {
    const { view, current } = stubView("\n第一段");
    splitDocTop(view, "");
    expect(current().doc.toString()).toBe("\n第一段");
    expect(current().selection.main.head).toBe(0);
  });

  test("caret at the end, empty doc: nothing inserted", () => {
    const { view, current } = stubView("");
    splitDocTop(view, "");
    expect(current().doc.toString()).toBe("");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading image void: paragraph lands above it, void source intact", () => {
    const { view, current } = stubView("![a](blob:x.png)\ntail");
    splitDocTop(view, "后半");
    expect(current().doc.toString()).toBe("后半\n![a](blob:x.png)\ntail");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading code fence: fence not corrupted", () => {
    const { view, current } = stubView("```js\nx()\n```");
    splitDocTop(view, "后半");
    expect(current().doc.toString()).toBe("后半\n```js\nx()\n```");
    expect(current().selection.main.head).toBe(0);
  });

  test("leading table: paragraph above the header row", () => {
    const { view, current } = stubView("| a |\n| --- |\n| 1 |");
    splitDocTop(view, "后半");
    expect(current().doc.toString()).toBe("后半\n| a |\n| --- |\n| 1 |");
    expect(current().selection.main.head).toBe(0);
  });
});
