import { test, expect } from "bun:test";
import { blocksFromBody, bodyFromBlocks, textToBlock, blockToText, shortcutFromInput } from "./blocks.ts";

test("textToBlock recognises each block type", () => {
  expect(textToBlock("# Title").type).toBe("h1");
  expect(textToBlock("## Title").type).toBe("h2");
  expect(textToBlock("### Title").type).toBe("h3");
  expect(textToBlock("- item")).toMatchObject({ type: "bullet", content: "item" });
  expect(textToBlock("1. item")).toMatchObject({ type: "numbered", content: "item" });
  expect(textToBlock("- [x] done")).toMatchObject({ type: "todo", content: "done", checked: true });
  expect(textToBlock("- [ ] todo")).toMatchObject({ type: "todo", content: "todo", checked: false });
  expect(textToBlock("> quote")).toMatchObject({ type: "quote", content: "quote" });
  expect(textToBlock("---").type).toBe("divider");
  expect(textToBlock("hello world")).toMatchObject({ type: "p", content: "hello world" });
});

test("code blocks keep their inner text whole", () => {
  const b = textToBlock("```ts\nconst x = 1\n\nconst y = 2\n```");
  expect(b.type).toBe("code");
  expect(b.lang).toBe("ts");
  expect(b.content).toBe("const x = 1\n\nconst y = 2");
  expect(blockToText({ id: "1", ...b })).toBe("```ts\nconst x = 1\n\nconst y = 2\n```");
});

test("blocksFromBody splits a tight list into one block per item", () => {
  const blocks = blocksFromBody("- a\n- b\n- c");
  expect(blocks.map((b) => b.type)).toEqual(["bullet", "bullet", "bullet"]);
  expect(blocks.map((b) => b.content)).toEqual(["a", "b", "c"]);
});

test("body round-trips through blocks and stays stable on re-parse", () => {
  const body = "# Heading\n\nA paragraph.\n\n- one\n- two\n\n> a quote\n\n```\ncode()\n```";
  const blocks = blocksFromBody(body);
  expect(blocks.map((b) => b.type)).toEqual([
    "h1",
    "p",
    "bullet",
    "bullet",
    "quote",
    "code",
  ]);
  const out = bodyFromBlocks(blocks);
  // re-parsing the serialized body yields the same block sequence (idempotent)
  expect(blocksFromBody(out).map((b) => [b.type, b.content])).toEqual(
    blocks.map((b) => [b.type, b.content]),
  );
});

test("empty paragraphs are dropped on serialize", () => {
  const blocks = [
    { id: "1", type: "p" as const, content: "keep" },
    { id: "2", type: "p" as const, content: "   " },
    { id: "3", type: "divider" as const, content: "" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n---");
});

test("nested ordered lists keep child paragraphs, quotes, and fenced code", () => {
  const body = [
    "4. Parent",
    "  9. Child",
    "",
    "    Child paragraph",
    "",
    "    > child quote",
    "",
    "    ```python",
    "    print('hi')",
    "    ```",
    "2. Sibling",
  ].join("\n");

  const blocks = blocksFromBody(body);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ type: "numbered", content: "Parent" });
  expect(blocks[0]!.children?.[0]).toMatchObject({ type: "numbered", content: "Child" });
  expect(blocks[0]!.children?.[0]?.children?.map((b) => [b.type, b.content, b.lang ?? ""])).toEqual([
    ["p", "Child paragraph", ""],
    ["quote", "child quote", ""],
    ["code", "print('hi')", "python"],
  ]);

  expect(bodyFromBlocks(blocks)).toBe([
    "1. Parent",
    "  1. Child",
    "",
    "    Child paragraph",
    "",
    "    > child quote",
    "",
    "    ```python",
    "    print('hi')",
    "    ```",
    "2. Sibling",
  ].join("\n"));
});

test("ordered numbering is recalculated per sibling level", () => {
  const blocks = blocksFromBody("3. top\n  9. nested\n  3. nested again\n8. next");
  expect(bodyFromBlocks(blocks)).toBe("1. top\n  1. nested\n  2. nested again\n2. next");
});

test("nested list serialization reflects indent and outdent moves", () => {
  const blocks = blocksFromBody("- one\n- child\n- two");
  const child = blocks.splice(1, 1)[0]!;
  blocks[0]!.children = [child];
  expect(bodyFromBlocks(blocks)).toBe("- one\n  - child\n- two");

  blocks.splice(1, 0, blocks[0]!.children!.shift()!);
  delete blocks[0]!.children;
  expect(bodyFromBlocks(blocks)).toBe("- one\n- child\n- two");
});

test("list items can own fenced code children", () => {
  const body = bodyFromBlocks([
    {
      id: "1",
      type: "bullet",
      content: "",
      children: [{ id: "2", type: "code", content: "print(1)", lang: "python" }],
    },
  ]);

  expect(body).toBe("- \n  ```python\n  print(1)\n  ```");

  const parsed = blocksFromBody(body);
  expect(parsed[0]).toMatchObject({ type: "bullet", content: "" });
  expect(parsed[0]!.children?.[0]).toMatchObject({ type: "code", content: "print(1)", lang: "python" });
});

test("typing shortcuts recognise markdown prefixes", () => {
  expect(shortcutFromInput("1. ", " ")).toMatchObject({ type: "numbered", content: "" });
  expect(shortcutFromInput("> ", " ")).toMatchObject({ type: "quote", content: "" });
  expect(shortcutFromInput("- [ ] ", " ")).toMatchObject({ type: "todo", checked: false });
  expect(shortcutFromInput("- [x] ", " ")).toMatchObject({ type: "todo", checked: true });
  expect(shortcutFromInput("## ", " ")).toMatchObject({ type: "h2", content: "" });
  expect(shortcutFromInput("```python", "Enter")).toMatchObject({ type: "code", lang: "python" });
});
