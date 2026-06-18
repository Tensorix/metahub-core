import { expect, test } from "bun:test";
import { bodyFromBlocks, type Block } from "./blocks.ts";
import {
  blockRangeIds,
  convertBlockType,
  deleteBlocks,
  duplicateBlocks,
  indentBlock,
  indentBlocks,
  moveBlocks,
  outdentBlock,
  outdentBlocks,
  serializeBlocks,
  topmostBlockIds,
} from "./editor-ops.ts";

test("indentBlock can move non-list blocks under a previous list item", () => {
  const blocks: Block[] = [
    { id: "one", type: "bullet", content: "one" },
    { id: "note", type: "quote", content: "nested note" },
    { id: "two", type: "bullet", content: "two" },
  ];

  expect(indentBlock(blocks, "note")).toBe(true);
  expect(bodyFromBlocks(blocks)).toBe("- one\n\n  > nested note\n- two");
});

test("outdentBlock lifts the current child and following siblings after the parent", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [
        { id: "child", type: "p", content: "child paragraph" },
        { id: "quote", type: "quote", content: "quote" },
        { id: "code", type: "code", content: "console.log(1)", lang: "ts" },
      ],
    },
    { id: "next", type: "bullet", content: "next" },
  ];

  expect(outdentBlock(blocks, "quote")).toBe(true);
  expect(bodyFromBlocks(blocks)).toBe([
    "- parent",
    "",
    "  child paragraph",
    "",
    "> quote",
    "",
    "```ts",
    "console.log(1)",
    "```",
    "",
    "- next",
  ].join("\n"));
});

test("outdentBlock removes empty children from the old parent", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "p", content: "child" }],
    },
  ];

  expect(outdentBlock(blocks, "child")).toBe(true);
  expect(blocks[0]!.children).toBeUndefined();
  expect(bodyFromBlocks(blocks)).toBe("- parent\n\nchild");
});

test("batch indent skips descendants whose ancestor is already selected", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
    { id: "two", type: "bullet", content: "two" },
  ];

  expect(topmostBlockIds(blocks, ["parent", "child"])).toEqual(["parent"]);
});

test("batch indent preserves selection order under the previous list item", () => {
  const blocks: Block[] = [
    { id: "one", type: "bullet", content: "one" },
    { id: "two", type: "bullet", content: "two" },
    { id: "three", type: "quote", content: "three" },
  ];

  expect(indentBlocks(blocks, ["two", "three"])).toEqual(["two", "three"]);
  expect(bodyFromBlocks(blocks)).toBe("- one\n  - two\n\n  > three");
});

test("batch outdent relies on tail lifting and avoids duplicate moves", () => {
  const blocks: Block[] = [
    {
      id: "one",
      type: "bullet",
      content: "one",
      children: [
        { id: "two", type: "bullet", content: "two" },
        { id: "three", type: "quote", content: "three" },
      ],
    },
  ];

  expect(outdentBlocks(blocks, ["two", "three"])).toEqual(["two"]);
  expect(bodyFromBlocks(blocks)).toBe("- one\n- two\n\n> three");
});

test("blockRangeIds spans the flatten range regardless of anchor/focus order", () => {
  const blocks: Block[] = [
    { id: "a", type: "p", content: "a" },
    { id: "b", type: "bullet", content: "b", children: [{ id: "c", type: "bullet", content: "c" }] },
    { id: "d", type: "p", content: "d" },
  ];

  expect(blockRangeIds(blocks, "a", "c")).toEqual(["a", "b", "c"]);
  expect(blockRangeIds(blocks, "c", "a")).toEqual(["a", "b", "c"]);
  expect(blockRangeIds(blocks, "missing", "a")).toEqual([]);
});

test("deleteBlocks removes the range and focuses the previous surviving block", () => {
  const blocks: Block[] = [
    { id: "one", type: "p", content: "one" },
    { id: "two", type: "p", content: "two" },
    { id: "three", type: "p", content: "three" },
    { id: "four", type: "p", content: "four" },
  ];

  expect(deleteBlocks(blocks, ["two", "three"])).toBe("one");
  expect(bodyFromBlocks(blocks)).toBe("one\n\nfour");
});

test("deleteBlocks falls back to the next block when nothing precedes the selection", () => {
  const blocks: Block[] = [
    { id: "one", type: "p", content: "one" },
    { id: "two", type: "p", content: "two" },
    { id: "three", type: "p", content: "three" },
  ];

  expect(deleteBlocks(blocks, ["one", "two"])).toBe("three");
  expect(bodyFromBlocks(blocks)).toBe("three");
});

test("deleteBlocks drops a selected parent together with its children", () => {
  const blocks: Block[] = [
    { id: "before", type: "p", content: "before" },
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
  ];

  expect(deleteBlocks(blocks, ["parent", "child"])).toBe("before");
  expect(bodyFromBlocks(blocks)).toBe("before");
});

test("duplicateBlocks copies the topmost group right after the selection", () => {
  const blocks: Block[] = [
    { id: "one", type: "bullet", content: "one" },
    { id: "two", type: "bullet", content: "two" },
    { id: "three", type: "bullet", content: "three" },
  ];

  const ids = duplicateBlocks(blocks, ["one", "two"]);
  expect(ids).toHaveLength(2);
  expect(bodyFromBlocks(blocks)).toBe("- one\n- two\n- one\n- two\n- three");
});

test("moveBlocks relocates the selected group after the target", () => {
  const blocks: Block[] = [
    { id: "one", type: "p", content: "one" },
    { id: "two", type: "p", content: "two" },
    { id: "three", type: "p", content: "three" },
  ];

  expect(moveBlocks(blocks, ["one", "two"], "three", "after")).toBe(true);
  expect(bodyFromBlocks(blocks)).toBe("three\n\none\n\ntwo");
});

test("moveBlocks refuses to move a group into its own subtree", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
  ];

  expect(moveBlocks(blocks, ["parent"], "child", "after")).toBe(false);
});

test("serializeBlocks renders the topmost selection as Markdown", () => {
  const blocks: Block[] = [
    { id: "h", type: "h2", content: "Title" },
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
  ];

  expect(serializeBlocks(blocks, ["h", "parent", "child"])).toBe("## Title\n- parent\n  - child");
});

test("convertBlockType changes a block's type in place and keeps its content", () => {
  const blocks: Block[] = [{ id: "p", type: "p", content: "hello" }];

  expect(convertBlockType(blocks, "p", "h2", { content: "hello" })).toBe(true);
  expect(blocks[0]!.type).toBe("h2");
  expect(blocks[0]!.content).toBe("hello");
});

test("convertBlockType keeps children when converting between list types", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
  ];

  convertBlockType(blocks, "parent", "todo", { content: "parent" });
  expect(blocks[0]!.type).toBe("todo");
  expect(blocks[0]!.children).toHaveLength(1);
});

test("convertBlockType drops children when the target is not a list type", () => {
  const blocks: Block[] = [
    {
      id: "parent",
      type: "bullet",
      content: "parent",
      children: [{ id: "child", type: "bullet", content: "child" }],
    },
  ];

  convertBlockType(blocks, "parent", "p", { content: "parent" });
  expect(blocks[0]!.type).toBe("p");
  expect(blocks[0]!.children).toBeUndefined();
});

test("convertBlockType returns false for an unknown id", () => {
  const blocks: Block[] = [{ id: "p", type: "p", content: "hello" }];

  expect(convertBlockType(blocks, "missing", "h1")).toBe(false);
});

test("serializeBlocks re-sequences numbered runs across the selection", () => {
  const blocks: Block[] = [
    { id: "a", type: "numbered", content: "a", start: 1 },
    { id: "b", type: "numbered", content: "b" },
    { id: "c", type: "numbered", content: "c" },
  ];

  expect(serializeBlocks(blocks, ["a", "b", "c"])).toBe("1. a\n2. b\n3. c");
});
