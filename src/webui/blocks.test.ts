import { test, expect } from "bun:test";
import { blocksFromBody, bodyFromBlocks, textToBlock, blockToText } from "./blocks.ts";

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
  const b = textToBlock("```\nconst x = 1\n\nconst y = 2\n```");
  expect(b.type).toBe("code");
  expect(b.content).toBe("const x = 1\n\nconst y = 2");
  expect(blockToText({ id: "1", ...b })).toBe("```\nconst x = 1\n\nconst y = 2\n```");
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
