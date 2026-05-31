import { expect, test } from "bun:test";
import { bodyFromBlocks, type Block } from "./blocks.ts";
import {
  indentBlock,
  indentBlocks,
  outdentBlock,
  outdentBlocks,
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
