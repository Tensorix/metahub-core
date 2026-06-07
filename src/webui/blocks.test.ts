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

test("interior empty paragraphs persist as blank lines on serialize", () => {
  const blocks = [
    { id: "1", type: "p" as const, content: "keep" },
    { id: "2", type: "p" as const, content: "   " }, // user spacing -> extra blank line
    { id: "3", type: "divider" as const, content: "" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n\n---");
});

test("trailing blank lines round-trip as empty paragraphs", () => {
  // one blank line at the end -> one empty paragraph that survives serialize
  const blocks = blocksFromBody("keep\n\n");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "keep"], ["p", ""]]);
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n");

  // two blank lines -> two empty paragraphs
  expect(blocksFromBody("keep\n\n\n").map((b) => b.type)).toEqual(["p", "p", "p"]);
  expect(bodyFromBlocks(blocksFromBody("keep\n\n\n"))).toBe("keep\n\n\n");
});

test("a single trailing newline is not a blank line", () => {
  const blocks = blocksFromBody("keep\n");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "keep"]]);
  expect(bodyFromBlocks(blocks)).toBe("keep");
});

test("interior and trailing empty paragraphs both survive serialize", () => {
  const blocks = [
    { id: "1", type: "p" as const, content: "keep" },
    { id: "2", type: "p" as const, content: "   " },
    { id: "3", type: "p" as const, content: "tail" },
    { id: "4", type: "p" as const, content: "" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n\ntail\n\n");
});

test("interior blank runs round-trip as empty paragraphs", () => {
  // one extra blank line between two paragraphs -> one interior empty paragraph
  const blocks = blocksFromBody("a\n\n\nb");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "a"], ["p", ""], ["p", "b"]]);
  expect(bodyFromBlocks(blocks)).toBe("a\n\n\nb");

  // interior + trailing together stay stable
  const body = "a\n\n\nb\n\n";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("blank lines between list items round-trip (tight list stays tight)", () => {
  // no blank between items -> tight list, no empty paragraph
  expect(bodyFromBlocks(blocksFromBody("- a\n- b"))).toBe("- a\n- b");

  // an empty paragraph between two bullets survives as one extra blank line
  const blocks = [
    { id: "1", type: "bullet" as const, content: "a" },
    { id: "2", type: "p" as const, content: "" },
    { id: "3", type: "bullet" as const, content: "b" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("- a\n\n\n- b");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["p", ""],
    ["bullet", "b"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body); // idempotent
});

test("an empty list item keeps its type across a round-trip (not a blank line)", () => {
  // leaving a list item empty = a blank *list item*; its marker is serialized so
  // it reloads as the same list type, not a plain gap.
  const blocks = [
    { id: "1", type: "bullet" as const, content: "a" },
    { id: "2", type: "bullet" as const, content: "" }, // empty bullet keeps its marker
    { id: "3", type: "bullet" as const, content: "b" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("- a\n- \n- b");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["bullet", ""],
    ["bullet", "b"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body); // idempotent
});

test("an empty ordered item keeps the list ordered across a round-trip", () => {
  // 1. foo / (empty) / 3. bar — the empty middle stays an ordered item ("2. ")
  const body = "1. foo\n2. \n3. bar";
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["numbered", "foo"],
    ["numbered", ""],
    ["numbered", "bar"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("deleting an item's marker leaves a plain paragraph gap", () => {
  // user removed the "2." marker -> the middle is a plain (empty) paragraph; it
  // round-trips as a blank line, staying a paragraph, not an ordered item.
  const blocks = [
    { id: "1", type: "numbered" as const, content: "foo" },
    { id: "2", type: "p" as const, content: "" }, // marker deleted -> plain gap
    { id: "3", type: "numbered" as const, content: "bar" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("1. foo\n\n\n2. bar");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["numbered", "foo"],
    ["p", ""],
    ["numbered", "bar"],
  ]);
});

test("a bare marker stripped of its trailing space still parses as an empty item", () => {
  expect(blocksFromBody("- a\n-\n- b").map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["bullet", ""],
    ["bullet", "b"],
  ]);
  // `---` is still a divider, `-foo` still a paragraph
  expect(blocksFromBody("---")[0]!.type).toBe("divider");
  expect(blocksFromBody("-foo")[0]!.type).toBe("p");
});

test("empty list items survive at any nesting depth", () => {
  const body = "- a\n  - x\n  - \n  - y\n- b";
  const blocks = blocksFromBody(body);
  expect(blocks[0]!.children?.map((b) => [b.type, b.content])).toEqual([
    ["bullet", "x"],
    ["bullet", ""],
    ["bullet", "y"],
  ]);
  expect(bodyFromBlocks(blocks)).toBe(body);
});

test("blank-line gaps survive between nested list items", () => {
  const body = "- a\n  - b\n\n\n  - c";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("blank-line gaps survive inside nested list content", () => {
  // an extra blank line between two child paragraphs of a list item is kept
  const body = "- a\n\n  child1\n\n\n  child2";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("a blank line between numbered items keeps the run going (1, 2)", () => {
  const blocks = [
    { id: "1", type: "numbered" as const, content: "a" },
    { id: "2", type: "p" as const, content: "" },
    { id: "3", type: "numbered" as const, content: "b" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("1. a\n\n\n2. b");
  expect(bodyFromBlocks(blocksFromBody("1. a\n\n\n2. b"))).toBe("1. a\n\n\n2. b");
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
    "5. Sibling",
  ].join("\n"));
});

test("ordered runs start at the first item's number, then auto-increment", () => {
  // The first item's number is honoured; later items re-sequence from it.
  const blocks = blocksFromBody("3. top\n  9. nested\n  3. nested again\n8. next");
  expect(bodyFromBlocks(blocks)).toBe("3. top\n  9. nested\n  10. nested again\n4. next");
});

test("ordered start is preserved across a Markdown round-trip", () => {
  const body = "5. a\n6. b\n7. c";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("repeated '1.' input re-sequences to 1, 2, 3", () => {
  const blocks = blocksFromBody("1. a\n1. b\n1. c");
  expect(bodyFromBlocks(blocks)).toBe("1. a\n2. b\n3. c");
  // start defaults away when it is 1
  expect(blocks[0]!.start).toBeUndefined();
});

test("only the first item of a run keeps an explicit start", () => {
  const blocks = blocksFromBody("5. a\n6. b");
  expect(blocks[0]!.start).toBe(5);
  expect(blocks[1]!.start).toBeUndefined();
});

test("deleting the first item re-sequences the run from the new head", () => {
  const blocks = blocksFromBody("5. a\n6. b\n7. c");
  blocks.shift(); // remove "5. a"
  expect(bodyFromBlocks(blocks)).toBe("1. b\n2. c");
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

test("GFM table parses into header + body rows with alignment", () => {
  const body = ["| Name | Age |", "| :--- | ---: |", "| Ann | 30 |", "| Bob | 7 |"].join("\n");
  const blocks = blocksFromBody(body);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    type: "table",
    rows: [["Name", "Age"], ["Ann", "30"], ["Bob", "7"]],
    align: ["left", "right"],
  });
});

test("table round-trips through Markdown and stays stable", () => {
  const body = ["| A | B | C |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n");
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("table cells escape pipes and pad short rows", () => {
  const blocks = blocksFromBody(["| a | b |", "| --- | --- |", "| x |"].join("\n"));
  // short body row is padded to the header column count
  expect(blocks[0]!.rows).toEqual([["a", "b"], ["x", ""]]);

  const out = bodyFromBlocks([
    { id: "1", type: "table", content: "", rows: [["a|b", "c"], ["d", "e"]], align: [null, null] },
  ]);
  expect(out).toBe(["| a\\|b | c |", "| --- | --- |", "| d | e |"].join("\n"));
  // escaped pipe survives the round-trip back into a single cell
  expect(blocksFromBody(out)[0]!.rows).toEqual([["a|b", "c"], ["d", "e"]]);
});

test("an empty table is dropped on serialize", () => {
  expect(bodyFromBlocks([{ id: "1", type: "table", content: "", rows: [["", ""], ["", ""]], align: [null, null] }])).toBe("");
});

test("a paragraph before a table is not merged into it", () => {
  const blocks = blocksFromBody(["intro", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  expect(blocks.map((b) => b.type)).toEqual(["p", "table"]);
});

test("typing shortcuts recognise markdown prefixes", () => {
  expect(shortcutFromInput("1. ", " ")).toMatchObject({ type: "numbered", content: "", start: 1 });
  expect(shortcutFromInput("5. ", " ")).toMatchObject({ type: "numbered", content: "", start: 5 });
  expect(shortcutFromInput("> ", " ")).toMatchObject({ type: "quote", content: "" });
  expect(shortcutFromInput("- [ ] ", " ")).toMatchObject({ type: "todo", checked: false });
  expect(shortcutFromInput("- [x] ", " ")).toMatchObject({ type: "todo", checked: true });
  expect(shortcutFromInput("## ", " ")).toMatchObject({ type: "h2", content: "" });
  expect(shortcutFromInput("```python", "Enter")).toMatchObject({ type: "code", lang: "python" });
});
